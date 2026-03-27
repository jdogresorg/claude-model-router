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
| Stop hook | `hooks/stop.js` | Logs token usage and claude-mem recalls from transcripts after every response |
| Session-start hook | `hooks/session-start.js` | Displays status banner and injects CLAUDE.md routing instructions |
| Session-end hook | `hooks/session-end.js` | Prints a colorized session summary when exiting |

## Session Status Display

At the start of every conversation, the session-start hook prints a colorized status banner to the terminal and injects a plain-text version into Claude's context. The banner is split into **Last Session** and **Lifetime** sections:

```
  [claude-model-router]
        Last Session (2026-03-27T03:51 to 2026-03-27T04:19)
            claude-mem   : 3 lookups | 2 observations | saved $1.42
            model-router : 8 interactions | 15,073,016 tokens | cost $22.96 (saved $11.33)
            models used  : opus: 6 ($21.02) | sonnet: 1 ($1.68) | haiku: 1 ($0.26)
            total costs  : $22.96 | Saved $12.75 | 35.7% savings
        Lifetime
            claude-mem   : 76 lookups | 4 observations | saved $5.19 (2,226 in knowledge base)
            model-router : 8 sessions | 125 interactions | 285,015,064 tokens | cost $485.16 (saved $296.30)
            models used  : opus: 58 ($421.80) | sonnet: 56 ($60.25) | haiku: 11 ($3.11)
            total costs  : $485.16 | Saved $301.49 | 38.6% savings
```

Each section shows:

- **claude-mem** — Recall stats from the [claude-mem](https://github.com/anthropics/claude-mem) knowledge base (lookups, observations retrieved, estimated savings from avoiding re-discovery). If claude-mem is installed but no recalls have occurred, shows the knowledge base size. If claude-mem is not installed, this line is omitted.
- **model-router** — Interaction count, total tokens processed, cost, and savings vs. an all-Opus baseline.
- **models used** — Per-model breakdown with invocation counts and costs. Model names are color-coded (magenta for Opus, blue for Sonnet, cyan for Haiku).
- **total costs** — Combined cost, combined savings (model-router + claude-mem), and overall savings percentage.

In the terminal, the banner uses ANSI colors: cyan header, yellow costs, green savings, and per-model colors. The version injected into Claude's context is plain text.

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

## Works Great With claude-mem

This plugin integrates with [claude-mem](https://github.com/thedotmack/claude-mem), a persistent cross-session memory system for Claude Code. When both plugins are installed, they complement each other to reduce token usage and API costs:

- **claude-mem reduces input tokens** — By recalling past discoveries, debugging sessions, and architectural decisions from its knowledge base, Claude avoids re-reading files and re-discovering context it has already learned. This directly cuts the input tokens billed on every turn.
- **model-router reduces output cost** — By routing simple sub-tasks to cheaper models (Haiku/Sonnet instead of Opus), the cost per output token drops significantly.
- **Combined savings are tracked** — The session status banner shows savings from both systems side by side, with a combined total. The stop hook automatically detects claude-mem tool calls in transcripts and logs recall events to the model-router database.
- **Knowledge base stats at a glance** — Even before any recalls happen, the banner shows how many observations are stored in claude-mem's knowledge base, so you can see the value accumulating.

No configuration is needed — if claude-mem is installed, the model-router detects it automatically by reading its SQLite database at `~/.claude-mem/claude-mem.db`.

## Data Storage

All data is stored in a local SQLite database (`~/.claude/.claude-model-router.db` by default). Nothing is sent externally beyond the Haiku classifier API calls (only when `route_task` is invoked).

## License

MIT
