/**
 * Model routing configuration — thresholds, pricing, and task-type mappings.
 *
 * Users can override defaults by passing env vars or providing a config file.
 */

// Per-token pricing (USD) — update when Anthropic changes pricing
export const MODEL_PRICING = {
  opus:   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
  sonnet: { input:  3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  haiku:  { input:  0.80 / 1_000_000, output:  4.00 / 1_000_000 },
};

// Default model selection matrix
// Key: `${complexity}:${contextDependency}`
export const MODEL_MATRIX = {
  'simple:low':   'haiku',
  'simple:high':  'sonnet',
  'medium:low':   'sonnet',
  'medium:high':  'opus',
  'complex:low':  'opus',
  'complex:high': 'opus',
};

// Task types and their natural model affinity (used as tiebreaker / override)
export const TASK_TYPE_AFFINITY = {
  docs:       'haiku',
  format:     'haiku',
  search:     'haiku',
  classify:   'haiku',
  summarize:  'sonnet',
  codegen:    'sonnet',
  review:     'sonnet',
  refactor:   'sonnet',
  test:       'sonnet',
  debug:      'opus',
  analysis:   'opus',
  architect:  'opus',
};

// Classifier model — the model used to classify incoming prompts
export const CLASSIFIER_MODEL = process.env.ROUTER_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';

// Minimum estimated output tokens for delegation to be worthwhile
export const MIN_DELEGATION_TOKENS = parseInt(process.env.ROUTER_MIN_DELEGATION_TOKENS || '500', 10);

// Path to SQLite database for logging
export const DB_PATH = process.env.ROUTER_DB_PATH || '.claude-model-router.db';

export default {
  MODEL_PRICING,
  MODEL_MATRIX,
  TASK_TYPE_AFFINITY,
  CLASSIFIER_MODEL,
  MIN_DELEGATION_TOKENS,
  DB_PATH,
};
