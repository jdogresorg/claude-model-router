#!/usr/bin/env node
/**
 * Claude Code SessionStart hook — queries claude-model-router's SQLite DB
 * and outputs lifetime stats so Claude sees them at conversation start.
 *
 * Outputs JSON with:
 *   - hookSpecificOutput.additionalContext: injected into Claude's context
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const DB_PATH = process.env.ROUTER_DB_PATH || resolve(homedir(), '.claude', '.claude-model-router.db');

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

  const statsText = lines.join('\n');

  output(statsText, statsText);
} catch (e) {
  console.error(`[model-router] Stats unavailable: ${e.message}`);
}
