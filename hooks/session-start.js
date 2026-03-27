#!/usr/bin/env node
/**
 * Claude Code SessionStart hook — queries claude-model-router's SQLite DB
 * and outputs lifetime stats so Claude sees them at conversation start.
 *
 * Outputs JSON with:
 *   - systemMessage: displayed in terminal to user
 *   - hookSpecificOutput.additionalContext: injected into Claude's context
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const DB_PATH = process.env.ROUTER_DB_PATH || resolve(homedir(), '.claude', '.claude-model-router.db');
const CLAUDE_MD_PATH = resolve(homedir(), '.claude', 'CLAUDE.md');

const MARKER_START = '<!-- claude-model-router:start -->';
const MARKER_END = '<!-- claude-model-router:end -->';

const ROUTING_SNIPPET = `${MARKER_START}
## REQUIRED: Cost-Optimized Model Selection for Subagents

When using the Agent tool, you MUST set the \`model\` parameter based on the subagent type and task. Do NOT leave it unset (defaults to opus). Use the cheapest model that can handle the task:

### Model Assignment Rules

**Use \`model: "haiku"\` for:**
- Explore agents (file searches, grep, codebase navigation, "find all X")
- Simple lookups, listing files, checking if something exists
- Formatting, linting, or mechanical transformations

**Use \`model: "sonnet"\` for:**
- general-purpose agents doing research, reading docs, summarizing code
- Code review, test generation, writing documentation
- Plan agents for straightforward feature planning
- Any agent task involving code generation that follows clear patterns

**Use \`model: "opus"\` only for:**
- Complex multi-file refactors requiring deep reasoning
- Debugging with hypothesis generation across multiple systems
- Architectural planning with significant trade-offs
- Tasks where a cheaper model already failed or produced poor results

### Examples

\`\`\`
// Searching for files — use haiku
Agent(subagent_type: "Explore", model: "haiku", prompt: "find all files importing Database")

// Research task — use sonnet
Agent(subagent_type: "general-purpose", model: "sonnet", prompt: "how does the auth middleware work")

// Complex refactor — use opus
Agent(subagent_type: "general-purpose", model: "opus", prompt: "refactor the pipeline to support batching with error recovery")
\`\`\`

Always set the model parameter. Never omit it.
${MARKER_END}`;

function ensureClaudeMdSnippet() {
  try {
    const dir = resolve(homedir(), '.claude');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(CLAUDE_MD_PATH)) {
      const content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
      if (content.includes(MARKER_START)) {
        // Update existing snippet if changed
        const re = new RegExp(
          MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '[\\s\\S]*?' +
          MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );
        const updated = content.replace(re, ROUTING_SNIPPET);
        if (updated !== content) writeFileSync(CLAUDE_MD_PATH, updated);
        return;
      }
      // Append snippet
      writeFileSync(CLAUDE_MD_PATH, content.trimEnd() + '\n\n' + ROUTING_SNIPPET + '\n');
    } else {
      writeFileSync(CLAUDE_MD_PATH, ROUTING_SNIPPET + '\n');
    }
  } catch {
    // Non-fatal — don't block session start
  }
}

function fmt(val) {
  return val < 1 ? `$${val.toFixed(4)}` : `$${val.toFixed(2)}`;
}

function pct(val) {
  return `${val.toFixed(1)}%`;
}

function output(additionalContext, systemMessage) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  if (systemMessage) {
    result.systemMessage = systemMessage;
  }
  console.log(JSON.stringify(result));
}

try {
  ensureClaudeMdSnippet();

  if (!existsSync(DB_PATH)) {
    output('[model-router] No data yet (database not found).');
    process.exit(0);
  }

  const db = new Database(DB_PATH, { readonly: true });

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(*) AS invocations,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(estimated_cost), 0) AS cost,
      COALESCE(SUM(opus_baseline_cost), 0) AS opus_baseline,
      COALESCE(SUM(savings), 0) AS savings
    FROM invocations
  `).get();

  if (row.invocations === 0) {
    output('[model-router] No interactions logged yet.');
    db.close();
    process.exit(0);
  }

  const savingsPct = row.opus_baseline > 0 ? (row.savings / row.opus_baseline) * 100 : 0;
  const totalTokens = (row.input_tokens + row.output_tokens).toLocaleString();

  const lines = [];

  lines.push(
    `[model-router] Lifetime: ${row.sessions} sessions, ${row.invocations} interactions | ` +
    `Cost: ${fmt(row.cost)} (saved ${fmt(row.savings)}, ${pct(savingsPct)}) | ` +
    `Tokens: ${totalTokens}`
  );

  // By model breakdown
  const models = db.prepare(`
    SELECT actual_model AS model, COUNT(*) AS n, SUM(estimated_cost) AS cost
    FROM invocations GROUP BY actual_model ORDER BY cost DESC
  `).all();

  if (models.length) {
    const parts = models.map(m => `${m.model}:${m.n}(${fmt(m.cost)})`);
    lines.push(`[model-router] By model: ${parts.join(' | ')}`);
  }

  // Last session summary
  const last = db.prepare(`
    SELECT session_id, MIN(timestamp) AS started, MAX(timestamp) AS ended,
           COUNT(*) AS n, SUM(estimated_cost) AS cost, SUM(savings) AS savings
    FROM invocations GROUP BY session_id ORDER BY started DESC LIMIT 1
  `).get();

  if (last) {
    lines.push(
      `[model-router] Last session: ${last.n} interactions, ` +
      `cost ${fmt(last.cost)}, saved ${fmt(last.savings)} ` +
      `(${last.started.slice(0, 16)} to ${last.ended.slice(0, 16)})`
    );
  }

  db.close();

  const statsText = '\n' + lines.join('\n');

  output(statsText, statsText);
} catch (e) {
  console.error(`[model-router] Stats unavailable: ${e.message}`);
}
