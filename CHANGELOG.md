# Changelog

All notable changes to claude-model-router will be documented in this file.

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
