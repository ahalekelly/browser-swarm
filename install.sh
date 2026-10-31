#!/bin/bash
# Install or update BrowserSwarm. Clone the repo, then run this script inside
# the clone: it fast-forwards the checkout, installs the pinned dependencies,
# Google Chrome and Playwright's Firefox, installs and starts the controller
# service, and generates the Claude Code and Codex agent definitions. Those
# definitions embed absolute paths into this checkout, so the install lives in
# a real clone that stays put.
set -euo pipefail
case "$(uname -sm)" in
  "Darwin arm64"|"Linux x86_64") ;;
  *) echo "ERROR: BrowserSwarm supports Darwin arm64 and Linux x86_64" >&2; exit 1 ;;
esac
cd "$(dirname "$0")"

git pull --ff-only
npm ci
# Chrome updates itself: through Google's apt repository on Linux, through
# Google's updater on macOS.
if [ "$(uname -s)" = Darwin ]; then
  [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || brew install --cask google-chrome
else
  [ -x /usr/bin/google-chrome-stable ] && command -v Xvfb >/dev/null || {
    echo "ERROR: BrowserSwarm needs Google Chrome stable and Xvfb. Add Google's apt repository (https://www.google.com/linuxrepositories/), then: sudo apt install google-chrome-stable xvfb" >&2
    exit 1
  }
fi
./install-playwright-firefox.sh
./install-controller-service.sh
./claude-agents/install-agents.sh
./codex-agents/install-agents.sh

echo
echo "BrowserSwarm installed at $PWD"
echo "Check the controller with: $PWD/swarm status"
