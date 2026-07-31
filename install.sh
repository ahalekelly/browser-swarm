#!/bin/bash
# One-command install, runnable without a checkout:
#   npx browser-swarm
# Clones the repo to ~/.browser-swarm (or fast-forwards an existing clone),
# installs the pinned MCP dependencies and the checksum-verified browser, and
# generates the Claude Code and Codex agent definitions. It installs a real clone
# rather than running from npx's cache because the agent definitions embed
# absolute paths that must stay valid: the cache is content-addressed,
# prunable, and re-fetched — everything a definition must not point into.
# From an existing checkout, skip this and run the component scripts directly.
set -euo pipefail
[ "$(uname -sm)" = "Darwin arm64" ] || { echo "ERROR: BrowserSwarm supports macOS on Apple silicon only" >&2; exit 1; }
TARGET="$HOME/.browser-swarm"
REPO="https://github.com/ahalekelly/browser-swarm.git"

if [ -d "$TARGET/.git" ]; then
  echo "updating existing install at $TARGET"
  git -C "$TARGET" pull --ff-only
elif [ -e "$TARGET" ]; then
  echo "ERROR: $TARGET exists but is not a git clone — move it aside and rerun" >&2
  exit 1
else
  git clone "$REPO" "$TARGET"
fi

cd "$TARGET"
npm ci
./install-fingerprint-chromium.sh
./claude-agents/install-agents.sh
./codex-agents/install-agents.sh

echo
echo "BrowserSwarm installed at $TARGET"
echo "The shared browser auto-starts when a swarm agent runs; manage it with:"
echo "  $TARGET/shared-browser.sh start|status|stop"
