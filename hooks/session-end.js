#!/usr/bin/env node
/**
 * Claude Code SessionEnd hook — prints a session summary to the terminal
 * when the user exits or clears the conversation.
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

try {
  if (!existsSync(DB_PATH)) process.exit(0);

  const db = new Database(DB_PATH, { readonly: true });

  // Get the most recent session's stats
  const last = db.prepare(`
    SELECT
      session_id,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
      COUNT(*) AS invocations,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(estimated_cost), 0) AS cost,
      COALESCE(SUM(opus_baseline_cost), 0) AS opus_baseline,
      COALESCE(SUM(savings), 0) AS savings
    FROM invocations
    GROUP BY session_id
    ORDER BY started DESC
    LIMIT 1
  `).get();

  if (!last || last.invocations === 0) {
    db.close();
    process.exit(0);
  }

  const savingsPct = last.opus_baseline > 0 ? (last.savings / last.opus_baseline) * 100 : 0;
  const totalTokens = ((last.input_tokens || 0) + (last.output_tokens || 0)).toLocaleString();

  const line = '='.repeat(60);
  console.log();
  console.log(line);
  console.log('  Model Router - Session Summary');
  console.log(line);
  console.log(`  Interactions:  ${last.invocations}`);
  console.log(`  Tokens:        ${totalTokens}`);
  console.log(`  Cost:          ${fmt(last.cost)}`);
  console.log(`  Opus baseline: ${fmt(last.opus_baseline)}`);
  console.log(`  Savings:       ${fmt(last.savings)} (${pct(savingsPct)})`);
  console.log(`  Duration:      ${last.started.slice(0, 16)} to ${last.ended.slice(0, 16)}`);

  // Task type breakdown
  const tasks = db.prepare(`
    SELECT task_type, COUNT(*) AS n, SUM(estimated_cost) AS cost
    FROM invocations WHERE session_id = ? GROUP BY task_type ORDER BY cost DESC
  `).all(last.session_id);

  if (tasks.length) {
    console.log(`  Tasks:         ${tasks.map(t => `${t.task_type}:${t.n}`).join(', ')}`);
  }

  console.log(line);
  console.log();

  db.close();
} catch (_) {
  // Never block exit with errors
}
