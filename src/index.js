#!/usr/bin/env node

/**
 * claude-model-router — MCP server for intelligent model selection.
 *
 * Exposes tools that Claude Code can call to classify prompts, select the
 * cheapest capable model, log invocations, and generate cost reports.
 *
 * Transport: stdio (standard MCP pattern for Claude Code integration).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { classifyAndRoute } from './classifier.js';
import {
  newSessionId,
  logInvocation,
  getLifetimeDetailedStats,
  closeDb,
} from './logger.js';
import { generateSessionReport, generateQuickSummary } from './reporter.js';
import { MODEL_PRICING, MODEL_MATRIX, TASK_TYPE_AFFINITY } from './config.js';

// One session per server lifetime (server restarts per Claude Code session)
const SESSION_ID = newSessionId();

const server = new McpServer({
  name: 'claude-model-router',
  version: '0.1.0',
});

// ─── Tool: route_task ────────────────────────────────────────────────
// Classifies a prompt and returns a model recommendation.
server.tool(
  'route_task',
  'Classify a task by complexity and return the cheapest capable model recommendation. Call this BEFORE delegating work to a subagent to decide which model to use.',
  {
    prompt: z.string().describe('The task description or user prompt to classify'),
    context: z.string().optional().describe('Optional context — file names involved, recent tool usage, project area'),
  },
  async ({ prompt, context }) => {
    try {
      const result = await classifyAndRoute(prompt, context || undefined);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                recommended_model: result.model,
                classification: result.classification,
                matrix_model: result.matrixModel,
                affinity_model: result.affinityModel,
                classifier_tokens_used: result.classifierTokens,
                session_id: SESSION_ID,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              recommended_model: 'opus',
              error: err.message,
              fallback: true,
              session_id: SESSION_ID,
            }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: log_invocation ────────────────────────────────────────────
// Records a completed task for cost tracking.
server.tool(
  'log_invocation',
  'Log any interaction for cost tracking. Call this AFTER every response — whether direct chat, agent sub-task, code edit, debug session, or research task.',
  {
    prompt_preview: z.string().describe('Short description of the interaction (first ~200 chars)'),
    actual_model: z.string().describe('The model that handled the interaction (e.g., "opus", "sonnet", "haiku")'),
    task_type: z.string().describe('Task type: chat, code_edit, debug, research, planning, commit, docs, format, search, classify, summarize, codegen, review, refactor, test, analysis, architect'),
    interaction_mode: z.string().optional().describe('Interaction mode: "direct" for primary conversation, "agent" for delegated sub-tasks, "tool" for tool-heavy responses. Defaults to "direct".'),
    complexity: z.string().optional().describe('Complexity classification: simple, medium, or complex. Defaults to "simple".'),
    context_dependency: z.string().optional().describe('Context dependency: low or high. Defaults to "low".'),
    recommended_model: z.string().optional().describe('The model that route_task recommended (only for agent sub-tasks)'),
    input_tokens: z.number().optional().describe('Input tokens consumed (estimate if exact count unavailable)'),
    output_tokens: z.number().optional().describe('Output tokens consumed (estimate if exact count unavailable)'),
    classifier_input_tokens: z.number().optional().describe('Input tokens used by the classifier call (from route_task)'),
    classifier_output_tokens: z.number().optional().describe('Output tokens used by the classifier call (from route_task)'),
    escalated: z.boolean().optional().describe('True if the task had to be re-run on a more capable model'),
    override_reason: z.string().optional().describe('Why the actual model differed from the recommendation, if applicable'),
    duration_ms: z.number().optional().describe('How long the task took in milliseconds'),
  },
  async (params) => {
    try {
      const result = logInvocation({
        sessionId: SESSION_ID,
        promptPreview: params.prompt_preview,
        complexity: params.complexity || 'simple',
        taskType: params.task_type,
        contextDep: params.context_dependency || 'low',
        interactionMode: params.interaction_mode || 'direct',
        mixed: false,
        recommendedModel: params.recommended_model,
        actualModel: params.actual_model,
        overrideReason: params.override_reason,
        inputTokens: params.input_tokens || 0,
        outputTokens: params.output_tokens || 0,
        classifierInputTokens: params.classifier_input_tokens || 0,
        classifierOutputTokens: params.classifier_output_tokens || 0,
        escalated: params.escalated || false,
        durationMs: params.duration_ms || 0,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              logged: true,
              estimated_cost: `$${result.estimatedCost.toFixed(4)}`,
              opus_baseline: `$${result.opusBaseline.toFixed(4)}`,
              savings: `$${result.savings.toFixed(4)}`,
              session_id: SESSION_ID,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Logging error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: session_report ────────────────────────────────────────────
// Generates a cost/savings report for the current or any session.
server.tool(
  'session_report',
  'Generate a cost-savings report with suggestions for the current session. Call this at the end of a session or when the user asks about routing efficiency.',
  {
    format: z.string().optional().describe('Report format: "full" for detailed markdown table, "quick" for one-line summary. Defaults to "full".'),
  },
  async ({ format }) => {
    try {
      const text =
        format === 'quick'
          ? generateQuickSummary(SESSION_ID)
          : generateSessionReport(SESSION_ID);

      return {
        content: [{ type: 'text', text }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Report error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_routing_config ────────────────────────────────────────
// Returns the current routing configuration for transparency.
server.tool(
  'get_routing_config',
  'Return the current model routing configuration — pricing, complexity matrix, and task-type affinities. Use this to explain routing decisions to the user.',
  {},
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              model_pricing: MODEL_PRICING,
              model_matrix: MODEL_MATRIX,
              task_type_affinity: TASK_TYPE_AFFINITY,
              session_id: SESSION_ID,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Tool: lifetime_stats ────────────────────────────────────────────
// Aggregate stats across all sessions.
server.tool(
  'lifetime_stats',
  'Return detailed cost, savings, and usage statistics across all recorded sessions — broken down by model, task type, and interaction mode.',
  {},
  async () => {
    try {
      const { totals, byModel, byTaskType, byMode } = getLifetimeDetailedStats();

      const formatCost = (v) => `$${(v || 0).toFixed(4)}`;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totals: {
                  sessions: totals.total_sessions,
                  invocations: totals.total_invocations,
                  input_tokens: totals.total_input_tokens,
                  output_tokens: totals.total_output_tokens,
                  cost: formatCost(totals.total_cost),
                  opus_baseline: formatCost(totals.total_opus_baseline),
                  savings: formatCost(totals.total_savings),
                  savings_pct: `${(totals.savings_pct || 0).toFixed(1)}%`,
                },
                by_model: byModel.map(r => ({
                  model: r.model,
                  invocations: r.invocations,
                  input_tokens: r.input_tokens,
                  output_tokens: r.output_tokens,
                  cost: formatCost(r.cost),
                })),
                by_task_type: byTaskType.map(r => ({
                  task_type: r.task_type,
                  invocations: r.invocations,
                  tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
                  cost: formatCost(r.cost),
                })),
                by_interaction_mode: byMode.map(r => ({
                  mode: r.interaction_mode,
                  invocations: r.invocations,
                  tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
                  cost: formatCost(r.cost),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Stats error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start server ────────────────────────────────────────────────────

const transport = new StdioServerTransport();

// Graceful shutdown
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

// IMPORTANT: Never use console.log in stdio MCP servers — it corrupts the protocol.
// Use console.error for debug output.
console.error(`[claude-model-router] Starting MCP server (session: ${SESSION_ID})`);

server.connect(transport).catch((err) => {
  console.error(`[claude-model-router] Failed to start: ${err.message}`);
  process.exit(1);
});
