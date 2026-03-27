# Changelog

All notable changes to claude-model-router will be documented in this file.

## [0.5.2] - 2026-03-26

### Added

- Cache token breakdown: new `base_input_tokens`, `cache_create_tokens`, `cache_read_tokens` columns in invocations table
- "Unique tokens" metric that excludes cache reads (which re-count the same context on every turn)
- `lifetime_stats` now returns `billing_tokens`, `unique_tokens`, and `token_breakdown` with all 4 categories
- Per-model stats show `billing_tokens`, `unique_tokens`, and `cache_read_tokens`
- Session-start/end banners show "X unique (Y billing incl. cache reads)" when cache data exists
- Auto-migration for existing databases (new columns default to 0 for historical rows)

## [0.5.0] - 2026-03-26

### Added

- claude-mem recall savings tracker: detects when claude-mem MCP tools are used to recall past work and estimates cost savings
- New `mem_recalls` SQLite table tracks every claude-mem tool call with observation IDs, discovery tokens, and estimated savings
- Stop hook scans transcripts (main + subagent) for claude-mem MCP tool calls (`get_observations`, `search`, `timeline`, `smart_*`)
- For `get_observations` calls, looks up `discovery_tokens` from claude-mem's SQLite DB to estimate what re-discovery would have cost
- Session report includes "Memory Recall Savings" section with per-tool breakdown
- `lifetime_stats` MCP tool returns `mem_recall_savings` block (total recalls, observations, discovery tokens, estimated savings, combined savings)
- Session-start banner shows mem recall stats: lookups, observations, discovery tokens, estimated savings
- New logger functions: `logMemRecall()`, `getSessionMemSavings()`, `getSessionMemToolBreakdown()`, `getLifetimeMemSavings()`
- Backwards-compatible: gracefully handles databases without `mem_recalls` table

## [0.4.3] - 2026-03-26

### Changed

- Rewrote model routing rules: two-step decision (agent type hard rules, then task classification for general-purpose)
- Added hard model assignments for Explore, claude-code-guide, statusline-setup, and Plan agent types
- Added escalation policy (retry at next tier on subagent failure)
- Rewrote README: plugin install flow, session status display docs, token tracking docs, CLAUDE.md auto-injection docs, updated routing rules section

## [0.4.2] - 2026-03-26

### Added

- Session-start hook auto-injects model routing instructions into `~/.claude/CLAUDE.md` (idempotent, marker-delimited)
- Stop hook now discovers and processes subagent transcripts alongside the main transcript

### Changed

- Stop hook refactored: transcript processing extracted into reusable `processTranscript()` helper
- Each subagent interaction is logged as a separate invocation row with `interaction_mode = 'agent'`

## [0.4.1] - 2026-03-26

### Fixed

- Add leading newline to session-start stats output so lines display below the hook header instead of inline

## [0.4.0] - 2026-03-26

### Added

- Converted to Claude Code plugin format (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`)
- Stop hook (`hooks/stop.js`) that automatically logs token usage from transcript data after every response
- Hooks are now self-registering via plugin system — no manual `settings.json` editing needed

### Removed

- `src/setup.js` CLI installer — replaced by plugin install (`claude --plugin-dir` or marketplace)
- `claude-md-snippet.md` — CLAUDE.md instructions now simplified (manual `log_invocation` no longer needed)
- `bin` and `files` fields from `package.json` (no longer an npx CLI tool)

### Changed

- CLAUDE.md instructions simplified: interaction logging is automatic, only agent routing requires manual calls
- Version bump to 0.4.0

## [0.3.1] - 2026-03-26

### Added

- SessionStart and SessionEnd hooks that query SQLite directly for stats display
- Setup script now installs/removes hooks in `.claude/settings.json` automatically
- `hooks/` directory included in published package

### Changed

- Removed "Session Start" and "Session Report" sections from CLAUDE.md snippet (now handled by hooks)
- Updated embedded CLAUDE_MD_SNIPPET to match trimmed instructions

## [0.2.0] - 2026-03-26

### Changed

- Migrated all MCP tool parameter schemas from plain JSON objects to Zod validation
- Added `zod` dependency
- Added author field to package.json

## [0.1.0] - 2026-03-26

### Added

- MCP server with 5 tools: `route_task`, `log_invocation`, `session_report`, `get_routing_config`, `lifetime_stats`
- Haiku-based prompt classifier with complexity/task-type/context-dependency detection
- Model selection matrix mapping classifications to cheapest capable model (Haiku, Sonnet, Opus)
- Task-type affinity system that can downgrade model selection for known-simple task types
- SQLite-based invocation logger with per-session and lifetime cost tracking
- Session report generator with model breakdown tables and actionable suggestions
- One-command setup: `npx claude-model-router --setup`
- One-command removal: `npx claude-model-router --uninstall`
- Idempotent CLAUDE.md snippet injection with marker-based install/uninstall
- Global install support via `--setup --global`
- Safe fallback to Opus when classifier fails or returns malformed JSON
- Configurable via environment variables: `ROUTER_CLASSIFIER_MODEL`, `ROUTER_DB_PATH`, `ROUTER_MIN_DELEGATION_TOKENS`
