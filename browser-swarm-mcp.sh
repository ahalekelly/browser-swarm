#!/bin/bash
# MCP entry point for the browser-swarm agent definitions: brings the shared
# daemon up if it stopped cleanly, then replaces itself with the pinned
# Playwright MCP attached to it. A crashed daemon is not auto-started —
# `ensure` fails, this script exits, and the agent's browser tools surface the
# crash to the orchestrator instead of hiding it behind a fresh browser.
# Everything before exec writes to stderr: stdout is the MCP stdio channel.
set -euo pipefail
NODE="${1:?usage: browser-swarm-mcp.sh <node-path> <agent-number>}"
N="${2:?usage: browser-swarm-mcp.sh <node-path> <agent-number>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/shared-browser.sh" ensure 1>&2
exec "$NODE" "$DIR/node_modules/@playwright/mcp/cli.js" \
  --cdp-endpoint "http://localhost:9377" --isolated \
  --output-dir "/tmp/claude/pwmcp-swarm-$N"
