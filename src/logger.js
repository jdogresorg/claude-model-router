/**
 * SQLite-based invocation logger.
 *
 * Records every routing decision and model invocation for cost tracking
 * and continuous improvement of the routing heuristics.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { DB_PATH, MODEL_PRICING } from './config.js';

let db = null;

function getDb() {
  if (!db) {
    const dbPath = DB_PATH.startsWith('/')
      ? DB_PATH
      : resolve(homedir(), '.claude', DB_PATH);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    initSchema(db);
  }
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      prompt_preview  TEXT,
      complexity      TEXT,
      task_type       TEXT,
      context_dep     TEXT,
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

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      total_invocations INTEGER DEFAULT 0,
      total_cost      REAL DEFAULT 0,
      total_opus_baseline REAL DEFAULT 0,
      total_savings   REAL DEFAULT 0,
      savings_pct     REAL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_inv_session ON invocations(session_id);
    CREATE INDEX IF NOT EXISTS idx_inv_timestamp ON invocations(timestamp);
  `);
}

/**
 * Generate a session ID based on timestamp.
 */
export function newSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Log a routing decision / invocation.
 */
export function logInvocation({
  sessionId,
  promptPreview,
  complexity,
  taskType,
  contextDep,
  mixed = false,
  recommendedModel,
  actualModel,
  overrideReason,
  inputTokens = 0,
  outputTokens = 0,
  classifierInputTokens = 0,
  classifierOutputTokens = 0,
  escalated = false,
  durationMs = 0,
}) {
  const database = getDb();

  const model = actualModel || recommendedModel;
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.opus;
  const estimatedCost = inputTokens * pricing.input + outputTokens * pricing.output;

  const opusBaseline =
    inputTokens * MODEL_PRICING.opus.input +
    outputTokens * MODEL_PRICING.opus.output;

  // Include classifier cost in the actual cost
  const classifierCost =
    classifierInputTokens * MODEL_PRICING.haiku.input +
    classifierOutputTokens * MODEL_PRICING.haiku.output;

  const totalCost = estimatedCost + classifierCost;
  const savings = opusBaseline - totalCost;

  const stmt = database.prepare(`
    INSERT INTO invocations (
      session_id, prompt_preview, complexity, task_type, context_dep, mixed,
      recommended_model, actual_model, override_reason,
      input_tokens, output_tokens,
      classifier_input_tokens, classifier_output_tokens,
      estimated_cost, opus_baseline_cost, savings,
      escalated, duration_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    sessionId,
    (promptPreview || '').slice(0, 200),
    complexity,
    taskType,
    contextDep,
    mixed ? 1 : 0,
    recommendedModel,
    model,
    overrideReason || null,
    inputTokens,
    outputTokens,
    classifierInputTokens,
    classifierOutputTokens,
    totalCost,
    opusBaseline,
    savings,
    escalated ? 1 : 0,
    durationMs,
  );

  return { estimatedCost: totalCost, opusBaseline, savings };
}

/**
 * Finalize a session — compute aggregates.
 */
export function finalizeSession(sessionId) {
  const database = getDb();

  const stats = database.prepare(`
    SELECT
      COUNT(*)                    AS total_invocations,
      COALESCE(SUM(estimated_cost), 0)     AS total_cost,
      COALESCE(SUM(opus_baseline_cost), 0) AS total_opus_baseline,
      COALESCE(SUM(savings), 0)            AS total_savings,
      SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) AS escalations,
      SUM(input_tokens)           AS total_input_tokens,
      SUM(output_tokens)          AS total_output_tokens
    FROM invocations
    WHERE session_id = ?
  `).get(sessionId);

  const savingsPct = stats.total_opus_baseline > 0
    ? (stats.total_savings / stats.total_opus_baseline) * 100
    : 0;

  database.prepare(`
    INSERT INTO sessions (id, total_invocations, total_cost, total_opus_baseline, total_savings, savings_pct, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      total_invocations = excluded.total_invocations,
      total_cost = excluded.total_cost,
      total_opus_baseline = excluded.total_opus_baseline,
      total_savings = excluded.total_savings,
      savings_pct = excluded.savings_pct,
      ended_at = excluded.ended_at
  `).run(
    sessionId,
    stats.total_invocations,
    stats.total_cost,
    stats.total_opus_baseline,
    stats.total_savings,
    savingsPct,
  );

  return { ...stats, savingsPct };
}

/**
 * Get stats for the last N sessions.
 */
export function getRecentSessions(limit = 10) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get per-model breakdown for a session.
 */
export function getSessionModelBreakdown(sessionId) {
  const database = getDb();
  return database.prepare(`
    SELECT
      actual_model AS model,
      COUNT(*) AS invocations,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(estimated_cost) AS cost,
      SUM(opus_baseline_cost) AS opus_baseline,
      SUM(savings) AS savings
    FROM invocations
    WHERE session_id = ?
    GROUP BY actual_model
    ORDER BY cost DESC
  `).all(sessionId);
}

/**
 * Get lifetime aggregate stats.
 */
export function getLifetimeStats() {
  const database = getDb();
  return database.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      COALESCE(SUM(total_invocations), 0) AS total_invocations,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(total_opus_baseline), 0) AS total_opus_baseline,
      COALESCE(SUM(total_savings), 0) AS total_savings,
      CASE WHEN SUM(total_opus_baseline) > 0
        THEN (SUM(total_savings) / SUM(total_opus_baseline)) * 100
        ELSE 0
      END AS savings_pct
    FROM sessions
  `).get();
}

/**
 * Get escalation patterns — tasks that were routed to a cheap model but had to retry.
 */
export function getEscalationPatterns(limit = 20) {
  const database = getDb();
  return database.prepare(`
    SELECT prompt_preview, complexity, task_type, recommended_model, actual_model
    FROM invocations
    WHERE escalated = 1
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export default {
  newSessionId,
  logInvocation,
  finalizeSession,
  getRecentSessions,
  getSessionModelBreakdown,
  getLifetimeStats,
  getEscalationPatterns,
  closeDb,
};
