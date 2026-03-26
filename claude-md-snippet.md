# Model Routing Instructions (add to your CLAUDE.md)

## Intelligent Model Routing

You have access to the `claude-model-router` MCP server. Use it to track token usage and minimize cost.

### Logging All Interactions

After **every response you give**, call `log_invocation` to record it. This includes simple chat, code edits, debugging, research — everything. Parameters:
- `actual_model`: the model you are running as (e.g., "opus")
- `task_type`: classify as: "chat", "code_edit", "debug", "research", "planning", "commit", "docs", "search", "review", "refactor", "test", "analysis", "architect"
- `interaction_mode`: "direct" for primary conversation, "agent" for delegated sub-tasks, "tool" for tool-heavy responses
- `complexity`: "simple", "medium", or "complex"
- `input_tokens`: estimate tokens in the user's message + relevant context
- `output_tokens`: estimate tokens in your response

### Agent Routing

1. **Before delegating any sub-task to an Agent**, call `route_task` with the task description. Use the recommended model in the Agent's `model` parameter.
2. **After each Agent completes**, call `log_invocation` with `interaction_mode: "agent"` and the actual token counts returned by the agent.

### Rules

- Always respect the router's recommendation for Agent sub-tasks unless you have a strong reason to override.
- If an Agent on a cheaper model produces poor results, re-run on the next tier up and log with `escalated: true`.
