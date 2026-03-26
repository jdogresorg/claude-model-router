# claude-model-router

MCP server that intelligently routes Claude Code sub-tasks to the cheapest capable model — reducing token costs by 35-50% without sacrificing quality on complex work.

## How It Works

1. **Classify** — Before delegating a sub-task, Claude calls `route_task`. A fast Haiku classifier analyzes the task's complexity, type, and context dependency.
2. **Route** — The classifier maps to the cheapest capable model (Haiku for docs/formatting, Sonnet for codegen/review, Opus for analysis/debugging).
3. **Log** — After each task, `log_invocation` records the model used and tokens consumed.
4. **Report** — `session_report` shows cost savings and actionable suggestions.

## Quick Start

### 1. Install dependencies

```bash
cd claude-model-router
npm install
```

### 2. Register with Claude Code

```bash
claude mcp add claude-model-router -- node /path/to/claude-model-router/src/index.js
```

Or add manually to your Claude Code settings:

```json
{
  "mcpServers": {
    "claude-model-router": {
      "command": "node",
      "args": ["/path/to/claude-model-router/src/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

### 3. Add routing instructions to CLAUDE.md

Copy the contents of `claude-md-snippet.md` into your project's `CLAUDE.md` file.

### 4. Use normally

Claude Code will automatically call `route_task` before delegating work to subagents, select the cheapest model, and track savings.

## Tools

| Tool | Purpose |
|---|---|
| `route_task` | Classify a task and get a model recommendation |
| `log_invocation` | Record a completed task for cost tracking |
| `session_report` | Generate a cost-savings report with suggestions |
| `get_routing_config` | View current routing configuration |
| `lifetime_stats` | Aggregate stats across all sessions |

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | API key for the Haiku classifier |
| `ROUTER_CLASSIFIER_MODEL` | `claude-haiku-4-5-20251001` | Model used for classification |
| `ROUTER_DB_PATH` | `.claude-model-router.db` | SQLite database path |
| `ROUTER_MIN_DELEGATION_TOKENS` | `500` | Minimum output tokens for routing to be worthwhile |

## Model Selection Matrix

| Complexity | Context Dependency | Selected Model |
|---|---|---|
| Simple | Low | Haiku |
| Simple | High | Sonnet |
| Medium | Low | Sonnet |
| Medium | High | Opus |
| Complex | Any | Opus |

Task-type affinity can further downgrade (never upgrade) the selection:

- **Haiku**: docs, formatting, search, classification
- **Sonnet**: summarization, code generation, review, refactoring, tests
- **Opus**: debugging, analysis, architecture

## Data Storage

All routing data is stored in a local SQLite database (`~/.claude/.claude-model-router.db` by default). Nothing is sent externally beyond the Haiku classifier API calls.

## License

MIT
