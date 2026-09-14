#!/bin/bash
# Install or update BrowserSwarm. Clone the repo, then run this script inside
# the clone: it fast-forwards the checkout, installs the pinned MCP
# dependencies and the checksum-verified browsers, and generates the Claude Code
# and Codex agent definitions. Those definitions embed absolute paths into this
# checkout, so the install lives in a real clone that stays put.
set -euo pipefail
case "$(uname -sm)" in
  "Darwin arm64"|"Linux x86_64") ;;
  *) echo "ERROR: BrowserSwarm supports Darwin arm64 and Linux x86_64" >&2; exit 1 ;;
esac
cd "$(dirname "$0")"

git pull --ff-only
npm ci
./install-fingerprint-chromium.sh
./install-playwright-firefox.sh
./claude-agents/install-agents.sh
./codex-agents/install-agents.sh

echo
echo "BrowserSwarm installed at $PWD"
echo "The shared browser auto-starts when a swarm agent runs; manage it with:"
echo "  $PWD/swarm start|status|stop [chromium|firefox]"
