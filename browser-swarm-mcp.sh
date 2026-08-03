#!/bin/bash
# MCP entry point for the browser-swarm agent definitions: brings the shared
# daemon up, then runs the pinned Playwright MCP attached to it under the
# per-session idle supervisor (mcp-session.js), which closes the session
# after five minutes without MCP activity so a wedged agent cannot hold its
# browser context forever.
# After a daemon crash, `ensure` restarts the browser but exits nonzero —
# this script dies with it, sacrificing this one agent's MCP so the agent
# reports the crash to the orchestrator instead of hiding it behind a fresh
# browser; relaunching the agent attaches normally.
# The agent tag labels the output dir and, for the Claude siblings, keeps
# their MCP configs byte-distinct (docs/claude-code-mcp-dedup.md); $$ makes
# the dir private per MCP session, so concurrent invocations of one
# definition never share files.
# Everything before exec writes to stderr: stdout is the MCP stdio channel.
set -euo pipefail
NODE="${1:?usage: browser-swarm-mcp.sh <node-path> <agent-tag>}"
TAG="${2:?usage: browser-swarm-mcp.sh <node-path> <agent-tag>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
IDLE_MS=300000
"$DIR/shared-browser.sh" ensure 1>&2
exec "$NODE" "$DIR/mcp-session.js" "$IDLE_MS" "$NODE" \
  "$DIR/node_modules/@playwright/mcp/cli.js" \
  --cdp-endpoint "http://localhost:9377" --isolated \
  --output-dir "/tmp/claude/pwmcp-swarm-$TAG-$$"
