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
  getLifetimeStats,
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
  'Log a completed task invocation for cost tracking. Call this AFTER a subagent or delegated task completes, passing the token counts and model used.',
  {
    prompt_preview: z.string().describe('Short description of the task (first ~200 chars)'),
    recommended_model: z.string().describe('The model that route_task recommended'),
    actual_model: z.string().describe('The model that actually executed the task (may differ if overridden)'),
    complexity: z.string().describe('Complexity classification: simple, medium, or complex'),
    task_type: z.string().describe('Task type: docs, format, search, classify, summarize, codegen, review, refactor, test, debug, analysis, architect'),
    context_dependency: z.string().describe('Context dependency: low or high'),
    input_tokens: z.number().optional().describe('Input tokens consumed by the task'),
    output_tokens: z.number().optional().describe('Output tokens consumed by the task'),
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
        complexity: params.complexity,
        taskType: params.task_type,
        contextDep: params.context_dependency,
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
  'Return aggregate cost and savings statistics across all recorded sessions.',
  {},
  async () => {
    try {
      const stats = getLifetimeStats();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                total_sessions: stats.total_sessions,
                total_invocations: stats.total_invocations,
                total_cost: `$${stats.total_cost.toFixed(4)}`,
                all_opus_baseline: `$${stats.total_opus_baseline.toFixed(4)}`,
                total_savings: `$${stats.total_savings.toFixed(4)}`,
                savings_pct: `${stats.savings_pct.toFixed(1)}%`,
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
