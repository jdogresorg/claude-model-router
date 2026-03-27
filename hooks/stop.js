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
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

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

// ── Helpers ──────────────────────────────────────────────────────────────

function processTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  const transcriptKey = transcriptPath.replace(/[^a-zA-Z0-9]/g, '_');
  const stateFile = resolve(STATE_DIR, `${transcriptKey}.offset`);
  const lastOffset = existsSync(stateFile)
    ? parseInt(readFileSync(stateFile, 'utf-8').trim(), 10) || 0
    : 0;

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.trimEnd().split('\n');

  const newEntries = [];
  for (let i = lastOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.usage) {
        const usage = entry.message.usage;
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

  writeFileSync(stateFile, String(lines.length));

  if (newEntries.length === 0) return null;

  let totalInput = 0;
  let totalOutput = 0;
  let model = 'opus';
  for (const e of newEntries) {
    totalInput += e.inputTokens;
    totalOutput += e.outputTokens;
    model = e.model;
  }

  const isSubagent = transcriptPath.includes('/subagents/');
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.opus;
  const estimatedCost = totalInput * pricing.input + totalOutput * pricing.output;
  const opusBaseline = totalInput * MODEL_PRICING.opus.input +
    totalOutput * MODEL_PRICING.opus.output;

  return {
    model,
    interactionMode: isSubagent ? 'agent' : 'direct',
    totalInput,
    totalOutput,
    estimatedCost,
    opusBaseline,
    savings: opusBaseline - estimatedCost,
    apiCalls: newEntries.length,
    stopReason: newEntries.at(-1)?.stopReason || 'unknown',
  };
}

function findSubagentTranscripts(mainTranscriptPath) {
  // Session dir is either the parent, or the parent has a subagents/ folder
  // Main transcript: /.../<session-id>.jsonl
  // Session dir:     /.../<session-id>/subagents/*.jsonl
  const sessionDirName = basename(mainTranscriptPath, '.jsonl');
  const sessionDir = resolve(dirname(mainTranscriptPath), sessionDirName, 'subagents');

  if (!existsSync(sessionDir)) return [];

  return readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => resolve(sessionDir, f));
}

// ── Main ────────────────────────────────────────────────────────────────

try {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
  const { session_id, transcript_path } = input;

  if (!transcript_path || !existsSync(transcript_path)) {
    process.exit(0);
  }

  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  // Process main transcript + all subagent transcripts
  const results = [];

  const mainResult = processTranscript(transcript_path);
  if (mainResult) results.push(mainResult);

  for (const subPath of findSubagentTranscripts(transcript_path)) {
    const subResult = processTranscript(subPath);
    if (subResult) results.push(subResult);
  }

  if (results.length === 0) {
    process.exit(0);
  }

  // Write all results to DB
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');

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

  const insert = db.prepare(`
    INSERT INTO invocations (
      session_id, timestamp, prompt_preview, task_type, interaction_mode,
      actual_model, input_tokens, output_tokens,
      estimated_cost, opus_baseline_cost, savings
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of results) {
    insert.run(
      session_id,
      new Date().toISOString(),
      `[auto] ${r.apiCalls} API call(s), ${r.stopReason}`,
      'auto',
      r.interactionMode,
      r.model,
      r.totalInput,
      r.totalOutput,
      r.estimatedCost,
      r.opusBaseline,
      r.savings,
    );
  }

  db.close();

} catch {
  // Never block Claude with hook errors
  process.exit(0);
}
