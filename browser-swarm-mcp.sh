#!/bin/bash
# MCP entry point for the browser-swarm agent definitions: brings the shared
# daemon up, then replaces itself with the pinned Playwright MCP attached to
# it. After a daemon crash, `ensure` restarts the browser but exits nonzero —
# this script dies with it, sacrificing this one agent's MCP so the agent
# reports the crash to the orchestrator instead of hiding it behind a fresh
# browser; relaunching the agent attaches normally.
# Everything before exec writes to stderr: stdout is the MCP stdio channel.
set -euo pipefail
NODE="${1:?usage: browser-swarm-mcp.sh <node-path> <agent-id>}"
N="${2:?usage: browser-swarm-mcp.sh <node-path> <agent-id>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/shared-browser.sh" ensure 1>&2
mkdir -p /tmp/claude
OUTPUT_DIR="$(mktemp -d "/tmp/claude/pwmcp-swarm-$N.XXXXXX")"
exec "$NODE" "$DIR/node_modules/@playwright/mcp/cli.js" \
  --cdp-endpoint "http://localhost:9377" --isolated \
  --output-dir "$OUTPUT_DIR"
