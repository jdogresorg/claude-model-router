#!/usr/bin/env node
/**
 * Claude Code Stop hook — fires after every assistant response.
 *
 * Reads the conversation transcript to extract actual token usage from the
 * Anthropic API response, then logs it directly to the model-router SQLite DB.
 *
 * This replaces the manual `log_invocation` MCP tool call that relied on
 * the AI to remember to log after every response.
 *
 * Stdin JSON from Claude Code:
 *   { session_id, transcript_path, cwd, stop_hook_active, ... }
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// ── Config ──────────────────────────────────────────────────────────────

const DB_PATH = process.env.ROUTER_DB_PATH ||
  resolve(homedir(), '.claude', '.claude-model-router.db');

const STATE_DIR = resolve(homedir(), '.claude', '.claude-model-router-state');

// Per-token pricing (USD) — keep in sync with config.js
const MODEL_PRICING = {
  opus:   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
  sonnet: { input:  3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  haiku:  { input:  0.80 / 1_000_000, output:  4.00 / 1_000_000 },
};

// Map API model IDs to short names
function normalizeModel(apiModel) {
  if (!apiModel) return 'opus';
  const m = apiModel.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'opus';
}

// ── Main ────────────────────────────────────────────────────────────────

try {
  // Read hook input from stdin
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  const { session_id, transcript_path } = input;

  if (!transcript_path || !existsSync(transcript_path)) {
    process.exit(0);
  }

  // State file tracks how many lines we've already processed for this transcript
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  // Use transcript filename as state key
  const transcriptKey = transcript_path.replace(/[^a-zA-Z0-9]/g, '_');
  const stateFile = resolve(STATE_DIR, `${transcriptKey}.offset`);
  const lastOffset = existsSync(stateFile)
    ? parseInt(readFileSync(stateFile, 'utf-8').trim(), 10) || 0
    : 0;

  // Read transcript and find new assistant entries with usage data
  const content = readFileSync(transcript_path, 'utf-8');
  const lines = content.trimEnd().split('\n');

  const newEntries = [];
  for (let i = lastOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.usage) {
        const usage = entry.message.usage;
        // Only count entries with actual output (skip streaming partials with 0 output)
        if (usage.output_tokens > 0) {
          newEntries.push({
            model: normalizeModel(entry.message.model),
            inputTokens: (usage.input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0) +
              (usage.cache_read_input_tokens || 0),
            outputTokens: usage.output_tokens || 0,
            stopReason: entry.message.stop_reason,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Save new offset
  writeFileSync(stateFile, String(lines.length));

  if (newEntries.length === 0) {
    process.exit(0);
  }

  // Aggregate all new entries into a single invocation record for this turn.
  // A single "turn" may have multiple API calls (tool_use -> continue -> end_turn).
  let totalInput = 0;
  let totalOutput = 0;
  let model = 'opus';

  for (const e of newEntries) {
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    model = e.model; // use the last one (they should all be the same)
  }

  // Determine interaction mode from transcript context
  // Subagent transcripts are in a /subagents/ directory
  const interactionMode = transcript_path.includes('/subagents/')
    ? 'agent' : 'direct';

  // Calculate costs
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.opus;
  const estimatedCost = totalInput * pricing.input + totalOutput * pricing.output;
  const opusBaseline = totalInput * MODEL_PRICING.opus.input +
    totalOutput * MODEL_PRICING.opus.output;
  const savings = opusBaseline - estimatedCost;

  // Write to DB
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');

  // Ensure schema exists (in case hook runs before MCP server)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      prompt_preview  TEXT,
      complexity      TEXT,
      task_type       TEXT,
      context_dep     TEXT,
      interaction_mode TEXT DEFAULT 'direct',
      mixed           INTEGER DEFAULT 0,
      recommended_model TEXT,
      actual_model    TEXT,
      override_reason TEXT,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      classifier_input_tokens  INTEGER DEFAULT 0,
      classifier_output_tokens INTEGER DEFAULT 0,
      estimated_cost  REAL DEFAULT 0,
      opus_baseline_cost REAL DEFAULT 0,
      savings         REAL DEFAULT 0,
      escalated       INTEGER DEFAULT 0,
      duration_ms     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inv_session ON invocations(session_id);
    CREATE INDEX IF NOT EXISTS idx_inv_timestamp ON invocations(timestamp);
  `);

  db.prepare(`
    INSERT INTO invocations (
      session_id, timestamp, prompt_preview, task_type, interaction_mode,
      actual_model, input_tokens, output_tokens,
      estimated_cost, opus_baseline_cost, savings
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id,
    new Date().toISOString(),
    `[auto] ${newEntries.length} API call(s), ${newEntries.at(-1)?.stopReason || 'unknown'}`,
    'auto',
    interactionMode,
    model,
    totalInput,
    totalOutput,
    estimatedCost,
    opusBaseline,
    savings,
  );

  db.close();

} catch {
  // Never block Claude with hook errors
  process.exit(0);
}
