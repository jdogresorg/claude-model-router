#!/usr/bin/env node
/**
 * One-time backfill: scan ALL transcripts from line 0 to find claude-mem
 * tool_use calls that were missed because the stop hook's offset had already
 * advanced past them before the mem recall detection was added (v0.5.0).
 *
 * Usage: node scripts/backfill-mem-recalls.js
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const DB_PATH = process.env.ROUTER_DB_PATH ||
  resolve(homedir(), '.claude', '.claude-model-router.db');

const CLAUDE_MEM_DB_PATH = process.env.CLAUDE_MEM_DATA_DIR
  ? resolve(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db')
  : resolve(homedir(), '.claude-mem', 'claude-mem.db');

const MEM_TOOL_PREFIX = 'mcp__plugin_claude-mem_mcp-search__';

const MODEL_PRICING = {
  opus: { output: 75.00 / 1_000_000 },
};

function findAllTranscripts() {
  const projectsDir = resolve(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  const files = [];

  function walk(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) files.push(full);
      }
    } catch { /* permission errors, etc */ }
  }

  walk(projectsDir);
  return files;
}

function extractAllMemRecalls(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.trimEnd().split('\n');
  const isSubagent = transcriptPath.includes('/subagents/');
  const recalls = [];

  // Try to extract session_id from the transcript path
  // Main transcripts: .../<session-id>.jsonl
  // Subagent transcripts: .../<session-id>/subagents/<agent-id>.jsonl
  let sessionId;
  if (isSubagent) {
    // Parent of /subagents/ dir is the session dir
    const parts = transcriptPath.split('/');
    const subIdx = parts.indexOf('subagents');
    sessionId = subIdx > 0 ? parts[subIdx - 1] : 'unknown';
  } else {
    sessionId = transcriptPath.split('/').pop().replace('.jsonl', '');
  }

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const blocks = entry.message?.content || [];
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.name?.startsWith(MEM_TOOL_PREFIX)) continue;
        const toolName = block.name.slice(MEM_TOOL_PREFIX.length);
        const recall = { toolName, observationIds: [], isSubagent, sessionId };

        if (toolName === 'get_observations' && Array.isArray(block.input?.ids)) {
          recall.observationIds = block.input.ids.map(Number).filter(n => n > 0);
        }
        recalls.push(recall);
      }
    } catch { /* skip */ }
  }

  return recalls;
}

function lookupDiscoveryTokens(observationIds) {
  if (!observationIds.length || !existsSync(CLAUDE_MEM_DB_PATH)) return 0;
  try {
    const memDb = new Database(CLAUDE_MEM_DB_PATH, { readonly: true });
    const placeholders = observationIds.map(() => '?').join(',');
    const result = memDb.prepare(
      `SELECT COALESCE(SUM(discovery_tokens), 0) AS total FROM observations WHERE id IN (${placeholders})`
    ).get(...observationIds);
    memDb.close();
    return result?.total || 0;
  } catch { return 0; }
}

// ── Main ──────────────────────────────────────────────────────────────

console.log('Scanning all transcripts for claude-mem tool calls...');

const transcripts = findAllTranscripts();
console.log(`Found ${transcripts.length} transcript files`);

const allRecalls = [];
for (const path of transcripts) {
  const recalls = extractAllMemRecalls(path);
  if (recalls.length > 0) {
    console.log(`  ${path.split('projects/')[1] || path}: ${recalls.length} recall(s)`);
    allRecalls.push(...recalls);
  }
}

console.log(`\nTotal recalls found: ${allRecalls.length}`);

if (allRecalls.length === 0) {
  console.log('Nothing to backfill.');
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure table exists
db.exec(`
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
`);

// Clear existing (in case of re-run)
const existing = db.prepare('SELECT COUNT(*) AS n FROM mem_recalls').get();
if (existing.n > 0) {
  console.log(`Clearing ${existing.n} existing mem_recalls rows...`);
  db.exec('DELETE FROM mem_recalls');
}

const insert = db.prepare(`
  INSERT INTO mem_recalls (
    session_id, tool_name, observation_ids, observation_count,
    discovery_tokens, estimated_savings, interaction_mode
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let totalDiscoveryTokens = 0;
let totalSavings = 0;

const insertMany = db.transaction(() => {
  for (const recall of allRecalls) {
    const discoveryTokens = recall.observationIds.length > 0
      ? lookupDiscoveryTokens(recall.observationIds)
      : 0;
    const estimatedSavings = discoveryTokens * MODEL_PRICING.opus.output;
    totalDiscoveryTokens += discoveryTokens;
    totalSavings += estimatedSavings;

    insert.run(
      recall.sessionId,
      recall.toolName,
      recall.observationIds.length > 0 ? JSON.stringify(recall.observationIds) : null,
      recall.observationIds.length,
      discoveryTokens,
      estimatedSavings,
      recall.isSubagent ? 'agent' : 'direct',
    );
  }
});

insertMany();
db.close();

console.log(`\nBackfill complete:`);
console.log(`  Recalls inserted: ${allRecalls.length}`);
console.log(`  Discovery tokens: ${totalDiscoveryTokens.toLocaleString()}`);
console.log(`  Estimated savings: $${totalSavings.toFixed(4)}`);
