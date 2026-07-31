#!/bin/bash
# One-command install, runnable without a checkout:
#   npx github:ahalekelly/browser-leaf
# Clones the repo to ~/.browser-leaf (or fast-forwards an existing clone),
# installs the pinned MCP dependencies and the checksum-verified browser, and
# generates the Claude Code agent definitions. It installs a real clone
# rather than running from npx's cache because the agent definitions embed
# absolute paths that must stay valid: the cache is content-addressed,
# prunable, and re-fetched — everything a definition must not point into.
# From an existing checkout, skip this and run the component scripts directly.
set -euo pipefail
[ "$(uname -sm)" = "Darwin arm64" ] || { echo "ERROR: browser-leaf supports macOS on Apple silicon only" >&2; exit 1; }
TARGET="$HOME/.browser-leaf"
REPO="https://github.com/ahalekelly/browser-leaf.git"

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

echo
echo "browser-leaf installed at $TARGET"
echo "The shared browser auto-starts when a leaf runs; manage it with:"
echo "  $TARGET/shared-browser.sh start|status|stop"
