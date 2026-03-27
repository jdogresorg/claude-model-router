# Changelog

All notable changes to claude-model-router will be documented in this file.

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
