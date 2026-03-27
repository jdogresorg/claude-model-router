/**
 * Session report generator.
 *
 * Produces a cost-savings summary and actionable suggestions
 * based on the logged invocations for a session or across sessions.
 */

import {
  finalizeSession,
  getSessionModelBreakdown,
  getSessionTaskTypeBreakdown,
  getSessionModeBreakdown,
  getLifetimeStats,
  getRecentSessions,
  getEscalationPatterns,
  getSessionMemSavings,
  getSessionMemToolBreakdown,
  getLifetimeMemSavings,
} from './logger.js';
import { MODEL_PRICING } from './config.js';

/**
 * Generate a session report as a formatted markdown string.
 */
export function generateSessionReport(sessionId) {
  const stats = finalizeSession(sessionId);
  const breakdown = getSessionModelBreakdown(sessionId);
  const taskTypeBreakdown = getSessionTaskTypeBreakdown(sessionId);
  const modeBreakdown = getSessionModeBreakdown(sessionId);
  const lifetime = getLifetimeStats();
  const escalations = getEscalationPatterns(5);

  const lines = [];

  lines.push('## Session Cost Report');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Invocations | ${stats.total_invocations} |`);
  lines.push(`| Input tokens (billing) | ${(stats.total_input_tokens || 0).toLocaleString()} |`);
  lines.push(`| Output tokens | ${(stats.total_output_tokens || 0).toLocaleString()} |`);
  lines.push(`| Total cost | $${stats.total_cost.toFixed(4)} |`);
  lines.push(`| All-Opus baseline | $${stats.total_opus_baseline.toFixed(4)} |`);
  lines.push(`| Savings | $${stats.total_savings.toFixed(4)} (${stats.savingsPct.toFixed(1)}%) |`);
  lines.push(`| Escalations | ${stats.escalations || 0} |`);
  lines.push('');

  if (breakdown.length > 0) {
    lines.push('### Model Breakdown');
    lines.push('');
    lines.push('| Model | Invocations | Input Tokens | Output Tokens | Cost | Savings |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of breakdown) {
      lines.push(
        `| ${row.model} | ${row.invocations} | ${row.input_tokens} | ${row.output_tokens} | $${row.cost.toFixed(4)} | $${row.savings.toFixed(4)} |`
      );
    }
    lines.push('');
  }

  if (taskTypeBreakdown.length > 0) {
    lines.push('### By Task Type');
    lines.push('');
    lines.push('| Task Type | Invocations | Tokens | Cost |');
    lines.push('|---|---|---|---|');
    for (const row of taskTypeBreakdown) {
      lines.push(
        `| ${row.task_type} | ${row.invocations} | ${(row.input_tokens || 0) + (row.output_tokens || 0)} | $${row.cost.toFixed(4)} |`
      );
    }
    lines.push('');
  }

  if (modeBreakdown.length > 0) {
    lines.push('### By Interaction Mode');
    lines.push('');
    lines.push('| Mode | Invocations | Tokens | Cost |');
    lines.push('|---|---|---|---|');
    for (const row of modeBreakdown) {
      lines.push(
        `| ${row.interaction_mode} | ${row.invocations} | ${(row.input_tokens || 0) + (row.output_tokens || 0)} | $${row.cost.toFixed(4)} |`
      );
    }
    lines.push('');
  }

  // claude-mem recall savings
  const memSavings = getSessionMemSavings(sessionId);
  const memToolBreakdown = getSessionMemToolBreakdown(sessionId);

  if (memSavings && memSavings.total_recalls > 0) {
    lines.push('### Memory Recall Savings (claude-mem)');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Recall events | ${memSavings.total_recalls} |`);
    lines.push(`| Observations recalled | ${memSavings.total_observations_recalled} |`);
    lines.push(`| Discovery tokens (original cost) | ${memSavings.total_discovery_tokens.toLocaleString()} |`);
    lines.push(`| Est. savings (vs re-discovery) | $${memSavings.total_estimated_savings.toFixed(4)} |`);
    lines.push('');

    if (memToolBreakdown.length > 0) {
      lines.push('| Tool | Calls | Observations | Discovery Tokens | Est. Savings |');
      lines.push('|---|---|---|---|---|');
      for (const row of memToolBreakdown) {
        lines.push(
          `| ${row.tool_name} | ${row.calls} | ${row.observations} | ${row.discovery_tokens.toLocaleString()} | $${row.savings.toFixed(4)} |`
        );
      }
      lines.push('');
    }
  }

  // Suggestions based on patterns
  const suggestions = generateSuggestions(stats, breakdown, escalations);
  if (suggestions.length > 0) {
    lines.push('### Suggestions');
    lines.push('');
    for (const s of suggestions) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  // Lifetime stats
  const lifetimeMem = getLifetimeMemSavings();

  if (lifetime.total_sessions > 1) {
    lines.push('### Lifetime Stats');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Total sessions | ${lifetime.total_sessions} |`);
    lines.push(`| Total cost | $${lifetime.total_cost.toFixed(4)} |`);
    lines.push(`| Total savings (routing) | $${lifetime.total_savings.toFixed(4)} (${lifetime.savings_pct.toFixed(1)}%) |`);
    if (lifetimeMem && lifetimeMem.total_recalls > 0) {
      lines.push(`| Total savings (mem recall) | $${lifetimeMem.total_estimated_savings.toFixed(4)} (${lifetimeMem.total_recalls} recalls, ${lifetimeMem.total_discovery_tokens.toLocaleString()} tokens) |`);
      lines.push(`| Combined savings | $${(lifetime.total_savings + lifetimeMem.total_estimated_savings).toFixed(4)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a compact one-line summary (for status bar / quick display).
 */
export function generateQuickSummary(sessionId) {
  const stats = finalizeSession(sessionId);
  if (stats.total_invocations === 0) {
    return 'No routed invocations this session.';
  }
  return `Session: ${stats.total_invocations} tasks, $${stats.total_cost.toFixed(4)} cost, saved $${stats.total_savings.toFixed(4)} (${stats.savingsPct.toFixed(1)}%) vs all-Opus`;
}

/**
 * Generate actionable suggestions based on session data.
 */
function generateSuggestions(stats, breakdown, escalations) {
  const suggestions = [];

  // Check if opus is being overused
  const opusRow = breakdown.find(r => r.model === 'opus');
  const totalInvocations = stats.total_invocations || 1;
  if (opusRow && opusRow.invocations / totalInvocations > 0.7) {
    suggestions.push(
      `${((opusRow.invocations / totalInvocations) * 100).toFixed(0)}% of tasks went to Opus. ` +
      `Review if some could be delegated — look for docs, formatting, or search tasks.`
    );
  }

  // Check escalation rate
  const escalationCount = stats.escalations || 0;
  if (escalationCount > 0 && escalationCount / totalInvocations > 0.15) {
    suggestions.push(
      `${escalationCount} escalation(s) detected (${((escalationCount / totalInvocations) * 100).toFixed(0)}%). ` +
      `The classifier may be too aggressive at downgrading. Consider tightening the complexity thresholds.`
    );
  }

  // Check if savings are below target
  if (stats.savingsPct < 20 && totalInvocations > 3) {
    suggestions.push(
      `Savings are only ${stats.savingsPct.toFixed(1)}%. Try breaking complex prompts into smaller sub-tasks ` +
      `so the simple parts can be routed to cheaper models.`
    );
  }

  // Check if haiku is underutilized
  const haikuRow = breakdown.find(r => r.model === 'haiku');
  if (!haikuRow && totalInvocations > 5) {
    suggestions.push(
      `Haiku was never used this session. Ensure docs, formatting, and simple search tasks are being classified correctly.`
    );
  }

  // No issues
  if (suggestions.length === 0 && stats.savingsPct > 30) {
    suggestions.push(
      `Good routing efficiency at ${stats.savingsPct.toFixed(1)}% savings. No action needed.`
    );
  }

  return suggestions;
}

export default { generateSessionReport, generateQuickSummary };
