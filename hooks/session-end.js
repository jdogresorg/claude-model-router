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
};

function fmt(val) {
  return val < 1 ? `$${val.toFixed(4)}` : `$${val.toFixed(2)}`;
}

function pct(val) {
  return `${val.toFixed(1)}%`;
}

try {
  if (!existsSync(DB_PATH)) process.exit(0);

  const db = new Database(DB_PATH);

  // Migration: ensure cache breakdown columns exist
  for (const col of ['base_input_tokens', 'cache_create_tokens', 'cache_read_tokens']) {
    try { db.exec(`ALTER TABLE invocations ADD COLUMN ${col} INTEGER DEFAULT 0`); } catch (_) { /* exists */ }
  }

  // Get the most recent session's stats
  const last = db.prepare(`
    SELECT
      session_id,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
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
    GROUP BY session_id
    ORDER BY started DESC
    LIMIT 1
  `).get();

  if (!last || last.invocations === 0) {
    db.close();
    process.exit(0);
  }

  const savingsPct = last.opus_baseline > 0 ? (last.savings / last.opus_baseline) * 100 : 0;
  const uniqueInput = (last.base_input_tokens || 0) + (last.cache_create_tokens || 0);
  const uniqueTokens = (uniqueInput + last.output_tokens).toLocaleString();
  const billingTokens = ((last.input_tokens || 0) + (last.output_tokens || 0)).toLocaleString();
  const hasCacheData = (last.cache_read_tokens || 0) > 0;

  const border = `${c.cyan}${'─'.repeat(58)}${c.reset}`;
  const tokensStr = hasCacheData ? `${uniqueTokens} unique ${c.gray}(${billingTokens} billing)${c.reset}` : billingTokens;

  console.log();
  console.log(`  ${border}`);
  console.log(`  ${c.bold}${c.cyan}  Model Router ${c.gray}─ Session Summary${c.reset}`);
  console.log(`  ${border}`);
  console.log(`  ${c.gray}  Interactions:${c.reset}  ${c.white}${last.invocations}${c.reset}`);
  console.log(`  ${c.gray}  Tokens:${c.reset}        ${c.white}${tokensStr}${c.reset}`);
  console.log(`  ${c.gray}  Cost:${c.reset}          ${c.yellow}${fmt(last.cost)}${c.reset}`);
  console.log(`  ${c.gray}  Opus baseline:${c.reset} ${c.dim}${fmt(last.opus_baseline)}${c.reset}`);
  console.log(`  ${c.gray}  Savings:${c.reset}       ${c.green}${c.bold}${fmt(last.savings)}${c.reset} ${c.green}(${pct(savingsPct)})${c.reset}`);
  console.log(`  ${c.gray}  Duration:${c.reset}      ${c.gray}${last.started.slice(0, 16)} to ${last.ended.slice(0, 16)}${c.reset}`);

  // Task type breakdown
  const tasks = db.prepare(`
    SELECT task_type, COUNT(*) AS n, SUM(estimated_cost) AS cost
    FROM invocations WHERE session_id = ? GROUP BY task_type ORDER BY cost DESC
  `).all(last.session_id);

  if (tasks.length) {
    const taskParts = tasks.map(t => `${c.white}${t.task_type}${c.reset}${c.gray}:${c.reset}${t.n}`);
    console.log(`  ${c.gray}  Tasks:${c.reset}         ${taskParts.join(', ')}`);
  }

  console.log(`  ${border}`);
  console.log();

  db.close();
} catch (_) {
  // Never block exit with errors
}
