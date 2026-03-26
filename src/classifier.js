/**
 * Haiku-based prompt classifier.
 *
 * Calls Claude Haiku to classify a user prompt into complexity, task type,
 * and context dependency — then maps that to the cheapest capable model.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODEL_MATRIX, TASK_TYPE_AFFINITY, CLASSIFIER_MODEL } from './config.js';

const CLASSIFICATION_PROMPT = `You are a task complexity classifier for an AI coding assistant.
Given the user's prompt, classify it along three dimensions.

1. COMPLEXITY — how much reasoning is required?
   - simple: single clear instruction, template-driven output, mechanical transformation, no multi-step reasoning
   - medium: requires code understanding OR synthesis, but the approach is straightforward
   - complex: multi-step reasoning, debugging with hypothesis generation, architectural trade-offs, novel problem-solving

2. TASK_TYPE — what kind of work is this?
   One of: docs, format, search, classify, summarize, codegen, review, refactor, test, debug, analysis, architect

3. CONTEXT_DEPENDENCY — how much project-specific knowledge is needed?
   - low: task is self-contained or needs only the files explicitly mentioned
   - high: requires understanding of project architecture, cross-file relationships, or history

4. MIXED — does the prompt contain multiple sub-tasks of clearly different complexity levels?
   - true or false

Respond with ONLY valid JSON, no markdown fences:
{"complexity":"...","task_type":"...","context_dependency":"...","mixed":false,"reasoning":"one sentence explaining your classification"}`;

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Classify a prompt and return a model recommendation.
 *
 * @param {string} prompt - The user's prompt text
 * @param {string} [context] - Optional surrounding context (file names, recent tools used)
 * @returns {Promise<{model: string, classification: object}>}
 */
export async function classifyAndRoute(prompt, context) {
  const userMessage = context
    ? `Context: ${context}\n\nUser prompt: ${prompt}`
    : `User prompt: ${prompt}`;

  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    messages: [
      { role: 'user', content: CLASSIFICATION_PROMPT + '\n\n' + userMessage },
    ],
  });

  const text = response.content[0]?.text || '{}';
  let classification;
  try {
    classification = JSON.parse(text);
  } catch {
    // If Haiku returns malformed JSON, default to opus (safe fallback)
    classification = {
      complexity: 'complex',
      task_type: 'analysis',
      context_dependency: 'high',
      mixed: false,
      reasoning: 'Classification parse failed — defaulting to opus',
    };
  }

  const matrixKey = `${classification.complexity}:${classification.context_dependency}`;
  const matrixModel = MODEL_MATRIX[matrixKey] || 'opus';

  // Task-type affinity can downgrade but never upgrade
  const affinityModel = TASK_TYPE_AFFINITY[classification.task_type];
  const modelRank = { haiku: 0, sonnet: 1, opus: 2 };
  const selectedModel =
    affinityModel && modelRank[affinityModel] < modelRank[matrixModel]
      ? affinityModel
      : matrixModel;

  // Token usage of the classifier call itself
  const classifierTokens = {
    input: response.usage?.input_tokens || 0,
    output: response.usage?.output_tokens || 0,
  };

  return {
    model: selectedModel,
    classification,
    matrixModel,
    affinityModel: affinityModel || null,
    classifierTokens,
  };
}

export default { classifyAndRoute };
