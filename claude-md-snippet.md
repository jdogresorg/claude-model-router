# Model Routing Instructions (add to your CLAUDE.md)

## Intelligent Model Routing

You have access to the `claude-model-router` MCP server. Use it to minimize token cost by routing tasks to the cheapest capable model.

### Workflow

1. **Before delegating any sub-task to an Agent**, call `route_task` with the task description. Use the recommended model in the Agent's `model` parameter.

2. **After each Agent completes**, call `log_invocation` with the token counts returned by the agent. This tracks cost savings.

3. **At the end of each session** (or when the user asks about costs), call `session_report` to show savings and get suggestions.

### Rules

- Always respect the router's recommendation unless you have a strong reason to override (e.g., the task requires conversation context that can't be summarized).
- If an Agent on a cheaper model produces poor results, re-run on the next tier up and log with `escalated: true`.
- For tasks under ~500 output tokens, skip routing — the classifier cost exceeds savings.
- Never route the primary complex task to a cheaper model. Routing is for **sub-tasks delegated to Agents**.
