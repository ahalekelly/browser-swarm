#!/bin/bash
# Launch one supervised Playwright MCP with its own headless Firefox process
# and persistent output directory. This launcher never touches the shared
# Chromium daemon.
set -euo pipefail
NODE="${1:?usage: firefox-mcp.sh <node-path> <agent-id>}"
N="${2:?usage: firefox-mcp.sh <node-path> <agent-id>}"
DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p /tmp/claude
OUTPUT_DIR="$(mktemp -d "/tmp/claude/pwmcp-ff-$N.XXXXXX")"
exec "$NODE" "$DIR/mcp-session.js" "300000" "$NODE" \
  "$DIR/node_modules/@playwright/mcp/cli.js" \
  --browser firefox --headless --isolated --output-dir "$OUTPUT_DIR"
