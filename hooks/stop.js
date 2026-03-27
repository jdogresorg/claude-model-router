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

const CLAUDE_MEM_DB_PATH = process.env.CLAUDE_MEM_DATA_DIR
  ? resolve(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db')
  : resolve(homedir(), '.claude-mem', 'claude-mem.db');

const STATE_DIR = resolve(homedir(), '.claude', '.claude-model-router-state');

// Per-token pricing (USD) — keep in sync with config.js
const MODEL_PRICING = {
  opus:   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
  sonnet: { input:  3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  haiku:  { input:  0.80 / 1_000_000, output:  4.00 / 1_000_000 },
};

// claude-mem MCP tool name prefix
const MEM_TOOL_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';

// Map API model IDs to short names
function normalizeModel(apiModel) {
  if (!apiModel) return 'opus';
  const m = apiModel.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'opus';
}

// ── claude-mem recall detection ──────────────────────────────────────────

/**
 * Scan transcript lines for claude-mem MCP tool calls.
 * Returns array of { toolName, observationIds, isSubagent }.
 *
 * We track:
 * - get_observations: has explicit IDs in input → look up discovery_tokens
 * - search/timeline: recall events but no direct observation IDs
 * - smart_outline/smart_unfold/smart_search: code structure lookups (no observation IDs, but still recall events)
 */
function extractMemRecalls(transcriptPath, startOffset) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.trimEnd().split('\n');
  const isSubagent = transcriptPath.includes('/subagents/');
  const recalls = [];

  for (let i = startOffset; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const blocks = entry.message?.content || [];
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.name?.startsWith(MEM_TOOL_PREFIX)) continue;
        const toolName = block.name.slice(MEM_TOOL_PREFIX.length);
        const recall = { toolName, observationIds: [], isSubagent };

        // Extract observation IDs from get_observations input
        if (toolName === 'get_observations' && Array.isArray(block.input?.ids)) {
          recall.observationIds = block.input.ids.map(Number).filter(n => n > 0);
        }

        recalls.push(recall);
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return recalls;
}

/**
 * Look up discovery_tokens from claude-mem's SQLite database for given observation IDs.
 * Returns total discovery_tokens for the requested IDs.
 */
function lookupDiscoveryTokens(observationIds) {
  if (!observationIds.length || !existsSync(CLAUDE_MEM_DB_PATH)) return 0;

  try {
    const memDb = new Database(CLAUDE_MEM_DB_PATH, { readonly: true });
    const placeholders = observationIds.map(() => '?').join(',');
    const result = memDb.prepare(`
      SELECT COALESCE(SUM(discovery_tokens), 0) AS total
      FROM observations
      WHERE id IN (${placeholders})
    `).get(...observationIds);
    memDb.close();
    return result?.total || 0;
  } catch {
    return 0;
  }
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
  const allMemRecalls = [];

  // Read offsets before processing (we need them for mem recall extraction too)
  const mainTranscriptKey = transcript_path.replace(/[^a-zA-Z0-9]/g, '_');
  const mainStateFile = resolve(STATE_DIR, `${mainTranscriptKey}.offset`);
  const mainOffset = existsSync(mainStateFile)
    ? parseInt(readFileSync(mainStateFile, 'utf-8').trim(), 10) || 0
    : 0;

  // Extract mem recalls from main transcript (before processTranscript updates offset)
  allMemRecalls.push(...extractMemRecalls(transcript_path, mainOffset));

  const mainResult = processTranscript(transcript_path);
  if (mainResult) results.push(mainResult);

  for (const subPath of findSubagentTranscripts(transcript_path)) {
    // Read subagent offset before processing
    const subKey = subPath.replace(/[^a-zA-Z0-9]/g, '_');
    const subStateFile = resolve(STATE_DIR, `${subKey}.offset`);
    const subOffset = existsSync(subStateFile)
      ? parseInt(readFileSync(subStateFile, 'utf-8').trim(), 10) || 0
      : 0;

    allMemRecalls.push(...extractMemRecalls(subPath, subOffset));

    const subResult = processTranscript(subPath);
    if (subResult) results.push(subResult);
  }

  if (results.length === 0 && allMemRecalls.length === 0) {
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
    CREATE TABLE IF NOT EXISTS mem_recalls (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id        TEXT NOT NULL,
      timestamp         TEXT NOT NULL DEFAULT (datetime('now')),
      tool_name         TEXT NOT NULL,
      observation_ids   TEXT,
      observation_count INTEGER DEFAULT 0,
      discovery_tokens  INTEGER DEFAULT 0,
      estimated_savings REAL DEFAULT 0,
      interaction_mode  TEXT DEFAULT 'direct'
    );
    CREATE INDEX IF NOT EXISTS idx_inv_session ON invocations(session_id);
    CREATE INDEX IF NOT EXISTS idx_inv_timestamp ON invocations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_mem_session ON mem_recalls(session_id);
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

  // Log claude-mem recall events
  if (allMemRecalls.length > 0) {
    const insertRecall = db.prepare(`
      INSERT INTO mem_recalls (
        session_id, tool_name, observation_ids, observation_count,
        discovery_tokens, estimated_savings, interaction_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const recall of allMemRecalls) {
      const discoveryTokens = recall.observationIds.length > 0
        ? lookupDiscoveryTokens(recall.observationIds)
        : 0;

      // Estimate savings: discovery_tokens valued at Opus output rates
      const estimatedSavings = discoveryTokens * MODEL_PRICING.opus.output;

      insertRecall.run(
        session_id,
        recall.toolName,
        recall.observationIds.length > 0 ? JSON.stringify(recall.observationIds) : null,
        recall.observationIds.length,
        discoveryTokens,
        estimatedSavings,
        recall.isSubagent ? 'agent' : 'direct',
      );
    }
  }

  db.close();

} catch {
  // Never block Claude with hook errors
  process.exit(0);
}
