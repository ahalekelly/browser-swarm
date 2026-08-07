#!/bin/bash
# MCP entry point for the launched-mode Firefox agent: runs the pinned
# Playwright MCP with its own headless Firefox under the per-session idle
# supervisor (src/mcp-session.ts). Never touches the shared Chromium daemon —
# CDP is Chromium-only. The agent tag labels the output dir; $$ makes it
# private per MCP session.
set -euo pipefail
NODE="${1:?usage: firefox-mcp.sh <node-path> <agent-tag>}"
TAG="${2:?usage: firefox-mcp.sh <node-path> <agent-tag>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
IDLE_MS=300000
exec "$NODE" "$DIR/src/mcp-session.ts" "$IDLE_MS" "$NODE" \
  "$DIR/node_modules/@playwright/mcp/cli.js" \
  --browser firefox --headless --isolated \
  --output-dir "/tmp/claude/pwmcp-ff-$TAG-$$"
