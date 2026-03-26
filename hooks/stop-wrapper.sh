#!/bin/bash
# Wrapper: capture stdin, wait for transcript flush, then process
# Required because Node.js ESM modules can't reliably read stdin
# when invoked directly by Claude Code hooks.

STDIN_DUMP="$HOME/.claude/.model-router-stop-stdin.json"

# Read stdin immediately (before pipe closes)
cat > "$STDIN_DUMP"
STDIN_SIZE=$(wc -c < "$STDIN_DUMP")

if [ "$STDIN_SIZE" -gt 2 ]; then
  # Wait for transcript to flush to disk
  sleep 1
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  cd "$SCRIPT_DIR/.."
  node "$SCRIPT_DIR/stop.js" < "$STDIN_DUMP" 2>/dev/null
fi
