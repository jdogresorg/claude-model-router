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

const CLAUDE_MEM_DB_PATH = process.env.CLAUDE_MEM_DATA_DIR
  ? resolve(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db')
  : resolve(homedir(), '.claude-mem', 'claude-mem.db');

const DB_PATH = process.env.ROUTER_DB_PATH || resolve(homedir(), '.claude', '.claude-model-router.db');
const CLAUDE_MD_PATH = resolve(homedir(), '.claude', 'CLAUDE.md');

const MARKER_START = '<!-- claude-model-router:start -->';
const MARKER_END = '<!-- claude-model-router:end -->';

const ROUTING_SNIPPET = `${MARKER_START}
## REQUIRED: Cost-Optimized Model Selection for Subagents

When using the Agent tool, you MUST set the \`model\` parameter. Never omit it.

### Step 1: Match by agent type (hard rules)

| subagent_type | model | Always? |
|---|---|---|
| Explore | haiku | Yes |
| claude-code-guide | haiku | Yes |
| statusline-setup | haiku | Yes |
| Plan | sonnet | Default — use opus only for ambiguous architectural trade-offs |
| general-purpose | (see Step 2) | |

### Step 2: For general-purpose agents, match by task

**haiku** — single-skill, no judgment needed:
- Git operations (status, log, diff, blame)
- Running a build or test suite and reporting results
- Listing, counting, or checking existence of files
- Formatting, linting, mechanical find-and-replace

**sonnet** — reasoning + generation within a bounded scope:
- Reading code and summarizing how it works
- Writing or updating tests for existing code
- Code review and suggesting improvements
- Writing docs, commit messages, or PR descriptions
- Implementing a feature that follows clear patterns (3 files or fewer)
- Research tasks (web search, doc lookup, reading APIs)

**opus** — deep reasoning across many files or ambiguous requirements:
- Multi-file refactors that must stay internally consistent
- Debugging that requires forming and testing hypotheses across systems
- Architectural design with significant trade-offs
- Any task where a sonnet agent already produced poor results

### Escalation

If a subagent's output is clearly wrong or incomplete, retry once with the next model tier (haiku to sonnet, sonnet to opus). Do not retry at the same tier.
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

// ANSI color helpers
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  bgCyan:  '\x1b[46m',
  bgBlue:  '\x1b[44m',
};

const MODEL_COLORS = {
  opus:   c.magenta,
  sonnet: c.blue,
  haiku:  c.cyan,
};

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

  const db = new Database(DB_PATH);

  // Migration: ensure cache breakdown columns exist
  for (const col of ['base_input_tokens', 'cache_create_tokens', 'cache_read_tokens']) {
    try { db.exec(`ALTER TABLE invocations ADD COLUMN ${col} INTEGER DEFAULT 0`); } catch (_) { /* exists */ }
  }

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(*) AS invocations,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(base_input_tokens), 0) AS base_input_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
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

  // ── Gather all data ──────────────────────────────────────────────────

  // Lifetime totals
  const lifetimeSavingsPct = row.opus_baseline > 0 ? (row.savings / row.opus_baseline) * 100 : 0;
  const lifetimeTokens = (row.input_tokens + row.output_tokens).toLocaleString();

  // Lifetime models
  const lifetimeModels = db.prepare(`
    SELECT actual_model AS model, COUNT(*) AS n, SUM(estimated_cost) AS cost
    FROM invocations GROUP BY actual_model ORDER BY cost DESC
  `).all();

  // Last session
  const last = db.prepare(`
    SELECT session_id, MIN(timestamp) AS started, MAX(timestamp) AS ended,
           COUNT(*) AS n,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(estimated_cost), 0) AS cost,
           COALESCE(SUM(opus_baseline_cost), 0) AS opus_baseline,
           COALESCE(SUM(savings), 0) AS savings
    FROM invocations GROUP BY session_id ORDER BY started DESC LIMIT 1
  `).get();

  const lastSavingsPct = last && last.opus_baseline > 0 ? (last.savings / last.opus_baseline) * 100 : 0;
  const lastTokens = last ? ((last.input_tokens || 0) + (last.output_tokens || 0)).toLocaleString() : '0';

  // Last session models
  const lastModels = last ? db.prepare(`
    SELECT actual_model AS model, COUNT(*) AS n, SUM(estimated_cost) AS cost
    FROM invocations WHERE session_id = ? GROUP BY actual_model ORDER BY cost DESC
  `).all(last.session_id) : [];

  // claude-mem data
  const memTableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='mem_recalls'
  `).get();

  let lifetimeMem = null;
  let lastMem = null;
  if (memTableExists) {
    lifetimeMem = db.prepare(`
      SELECT COUNT(*) AS recalls, COALESCE(SUM(observation_count), 0) AS observations,
             COALESCE(SUM(estimated_savings), 0) AS savings
      FROM mem_recalls
    `).get();

    if (last) {
      lastMem = db.prepare(`
        SELECT COUNT(*) AS recalls, COALESCE(SUM(observation_count), 0) AS observations,
               COALESCE(SUM(estimated_savings), 0) AS savings
        FROM mem_recalls WHERE session_id = ?
      `).get(last.session_id);
    }
  }

  // claude-mem knowledge base stats
  let memDbStats = null;
  if (existsSync(CLAUDE_MEM_DB_PATH)) {
    try {
      const memDb = new Database(CLAUDE_MEM_DB_PATH, { readonly: true });
      memDbStats = memDb.prepare(`
        SELECT COUNT(*) AS total_observations,
               COALESCE(SUM(discovery_tokens), 0) AS total_discovery_tokens
        FROM observations
      `).get();
      memDb.close();
    } catch { /* non-fatal */ }
  }

  db.close();

  // ── Format output ────────────────────────────────────────────────────

  const sep = `${c.gray}|${c.reset}`;
  const indent = '        ';
  const label = (text) => `${c.gray}${text}${c.reset}`;

  function fmtModels(models) {
    return models.map(m => {
      const mc = MODEL_COLORS[m.model] || c.white;
      return `${mc}${c.bold}${m.model}${c.reset}${c.gray}:${c.reset} ${c.white}${m.n}${c.reset} ${c.gray}(${c.reset}${c.yellow}${fmt(m.cost)}${c.reset}${c.gray})${c.reset}`;
    }).join(` ${sep} `);
  }

  function fmtMemLine(mem) {
    if (!mem || mem.recalls === 0) return `${c.dim}no recalls yet${c.reset}`;
    return `${c.white}${mem.recalls}${c.reset} lookups ${sep} ${c.white}${mem.observations}${c.reset} observations ${sep} saved ${c.green}${fmt(mem.savings)}${c.reset}`;
  }

  function fmtTotalCosts(cost, savings, savingsPct) {
    return `${c.yellow}${fmt(cost)}${c.reset} ${sep} Saved ${c.green}${c.bold}${fmt(savings)}${c.reset} ${sep} ${c.green}${pct(savingsPct)}${c.reset} savings`;
  }

  const lines = [];
  const header = `${c.bold}${c.cyan}[claude-model-router]${c.reset}`;
  lines.push(`  ${header}`);

  // ── Last Session ─────────────────────────────────────────────────────
  if (last) {
    lines.push(`${indent}${c.bold}${c.white}Last Session${c.reset} ${c.gray}(${last.started.slice(0, 16)} to ${last.ended.slice(0, 16)})${c.reset}`);
    lines.push(`${indent}    ${label('claude-mem   :')} ${fmtMemLine(lastMem)}`);
    lines.push(
      `${indent}    ${label('model-router :')} ` +
      `${c.white}${last.n}${c.reset} interactions ${sep} ` +
      `${c.white}${lastTokens}${c.reset} tokens ${sep} ` +
      `cost ${c.yellow}${fmt(last.cost)}${c.reset} ${c.gray}(${c.reset}saved ${c.green}${fmt(last.savings)}${c.reset}${c.gray})${c.reset}`
    );
    if (lastModels.length) {
      lines.push(`${indent}    ${label('models used  :')} ${fmtModels(lastModels)}`);
    }
    const lastTotalCost = last.cost;
    const lastTotalSavings = last.savings + (lastMem?.savings || 0);
    const lastTotalBaseline = last.opus_baseline;
    const lastTotalPct = lastTotalBaseline > 0 ? (lastTotalSavings / lastTotalBaseline) * 100 : 0;
    lines.push(`${indent}    ${label('total costs  :')} ${fmtTotalCosts(lastTotalCost, lastTotalSavings, lastTotalPct)}`);
  }

  // ── Lifetime ─────────────────────────────────────────────────────────
  lines.push(`${indent}${c.bold}${c.white}Lifetime${c.reset}`);
  lines.push(`${indent}    ${label('claude-mem   :')} ${fmtMemLine(lifetimeMem)}${memDbStats ? ` ${c.gray}(${memDbStats.total_observations.toLocaleString()} in knowledge base)${c.reset}` : ''}`);
  lines.push(
    `${indent}    ${label('model-router :')} ` +
    `${c.white}${row.sessions}${c.reset} sessions ${sep} ` +
    `${c.white}${row.invocations}${c.reset} interactions ${sep} ` +
    `${c.white}${lifetimeTokens}${c.reset} tokens ${sep} ` +
    `cost ${c.yellow}${fmt(row.cost)}${c.reset} ${c.gray}(${c.reset}saved ${c.green}${fmt(row.savings)}${c.reset}${c.gray})${c.reset}`
  );
  if (lifetimeModels.length) {
    lines.push(`${indent}    ${label('models used  :')} ${fmtModels(lifetimeModels)}`);
  }
  const lifetimeTotalCost = row.cost;
  const lifetimeTotalSavings = row.savings + (lifetimeMem?.savings || 0);
  const lifetimeTotalBaseline = row.opus_baseline;
  const lifetimeTotalPct = lifetimeTotalBaseline > 0 ? (lifetimeTotalSavings / lifetimeTotalBaseline) * 100 : 0;
  lines.push(`${indent}    ${label('total costs  :')} ${fmtTotalCosts(lifetimeTotalCost, lifetimeTotalSavings, lifetimeTotalPct)}`);

  const statsText = '\n' + lines.join('\n');

  // additionalContext goes into Claude's context — strip ANSI for that
  const plainText = statsText.replace(/\x1b\[[0-9;]*m/g, '');
  output(plainText, statsText);
} catch (e) {
  console.error(`[model-router] Stats unavailable: ${e.message}`);
}
