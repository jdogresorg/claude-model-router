# claude-model-router

Claude Code plugin that automatically tracks token usage across all interactions and routes sub-tasks to the cheapest capable model — reducing costs by 35-50% without sacrificing quality on complex work.

## How It Works

1. **Track** — A stop hook automatically logs token usage from every response (including subagent transcripts) to a local SQLite database.
2. **Instruct** — On session start, model routing instructions are injected into `~/.claude/CLAUDE.md` so Claude always selects the cheapest capable model for subagents.
3. **Report** — Session-start displays lifetime cost stats and savings. The `session_report` MCP tool gives detailed breakdowns.
4. **Route** — The `route_task` MCP tool classifies tasks via a fast Haiku call and recommends the optimal model.

## Quick Start

### 1. Install dependencies

```bash
cd claude-model-router
npm install
```

### 2. Install as a Claude Code plugin

```bash
claude plugin add /path/to/claude-model-router
```

This registers the MCP server and hooks automatically — no manual `settings.json` editing required.

### 3. Use normally

Everything is automatic:
- Token usage is logged after every response (main thread and subagents)
- Model routing instructions are maintained in `~/.claude/CLAUDE.md`
- Lifetime stats are displayed at the start of each session

## What Gets Installed

| Component | File | Purpose |
|---|---|---|
| MCP server | `src/index.js` | Provides `route_task`, `session_report`, `lifetime_stats`, and other tools |
| Stop hook | `hooks/stop.js` | Logs token usage from transcripts after every response |
| Session-start hook | `hooks/session-start.js` | Displays stats and injects CLAUDE.md routing instructions |

## Session Status Display

At the start of every conversation, the session-start hook prints a status banner to the terminal and injects the same data into Claude's context. The output looks like this:

```
[model-router] Lifetime: 17 sessions, 66 interactions | Cost: $763.26 (saved $510.85, 40.1%) | Tokens: 83,539,154
[model-router] By model: opus:45($668.97) | sonnet:9($84.57) | haiku:12($9.72)
[model-router] Last session: 11 interactions, cost $102.37, saved $349.65 (2026-03-27T00:16 to 2026-03-27T00:16)
```

**Line 1 — Lifetime totals:** Total sessions, interactions, cumulative cost, savings vs. all-Opus baseline, and total tokens processed.

**Line 2 — Model breakdown:** How many interactions used each model tier and the cost attributed to each.

**Line 3 — Last session:** A quick summary of the most recent session's activity, cost, and savings.

This gives you an at-a-glance picture of your cost efficiency every time you start Claude Code.

## Token Tracking

The stop hook runs after every Claude response and processes the conversation transcript to extract token usage. It handles:

- **Main thread:** Parses the primary transcript file for assistant messages with usage data.
- **Subagents:** Discovers transcript files in the session's `subagents/` directory and processes each one independently.
- **Incremental processing:** Tracks a file offset per transcript so it only processes new entries, not the entire file each time.

Each interaction is logged as a row in the SQLite database with the model used, token counts, estimated cost, and the opus-baseline cost (what it would have cost if Opus handled everything). Subagent interactions are tagged with `interaction_mode = 'agent'` to distinguish them from direct interactions.

## CLAUDE.md Auto-Injection

On session start, the plugin writes (or updates) a model routing instructions block in `~/.claude/CLAUDE.md`. This block is delimited by HTML comment markers:

```
<!-- claude-model-router:start -->
...routing instructions...
<!-- claude-model-router:end -->
```

The injection is idempotent — if the markers already exist, only the content between them is replaced. If `CLAUDE.md` doesn't exist yet, it's created. This ensures Claude always has up-to-date instructions for selecting the cheapest capable model when spawning subagents.

## MCP Tools

| Tool | Purpose |
|---|---|
| `route_task` | Classify a task and get a model recommendation |
| `log_invocation` | Manually record a completed task for cost tracking |
| `session_report` | Generate a cost-savings report with suggestions |
| `get_routing_config` | View current routing configuration |
| `lifetime_stats` | Aggregate stats across all sessions |

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required for `route_task`) | API key for the Haiku classifier |
| `ROUTER_CLASSIFIER_MODEL` | `claude-haiku-4-5-20251001` | Model used for task classification |
| `ROUTER_DB_PATH` | `~/.claude/.claude-model-router.db` | SQLite database path |
| `ROUTER_MIN_DELEGATION_TOKENS` | `500` | Minimum output tokens for routing to be worthwhile |

## Model Routing Rules

Routing uses a two-step decision process injected into `~/.claude/CLAUDE.md`:

### Step 1: Agent type (hard rules)

| Agent type | Model | Override? |
|---|---|---|
| Explore | haiku | Never |
| claude-code-guide | haiku | Never |
| statusline-setup | haiku | Never |
| Plan | sonnet | Opus only for ambiguous architectural trade-offs |
| general-purpose | See step 2 | |

### Step 2: Task classification (general-purpose only)

| Model | Task characteristics | Examples |
|---|---|---|
| haiku | Single-skill, no judgment | git ops, running tests, listing files, formatting |
| sonnet | Reasoning + generation, bounded scope (3 files or fewer) | code review, writing tests, research, clear-pattern features |
| opus | Deep reasoning across many files or ambiguous requirements | multi-file refactors, cross-system debugging, architecture |

If a subagent produces poor results, the escalation rule is to retry once at the next tier (haiku to sonnet, sonnet to opus) rather than retrying at the same level.

### MCP classifier (optional)

The `route_task` MCP tool provides an alternative automated path — it sends a lightweight prompt to Haiku to classify complexity, task type, and context dependency, then maps the result to a model using this matrix:

| Complexity | Context Dependency | Selected Model |
|---|---|---|
| Simple | Low | Haiku |
| Simple | High | Sonnet |
| Medium | Low | Sonnet |
| Medium | High | Opus |
| Complex | Any | Opus |

## Data Storage

All data is stored in a local SQLite database (`~/.claude/.claude-model-router.db` by default). Nothing is sent externally beyond the Haiku classifier API calls (only when `route_task` is invoked).

## License

MIT
