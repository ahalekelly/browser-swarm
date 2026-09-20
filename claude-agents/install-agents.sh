#!/bin/bash
# Generate both BrowserSwarm agent definitions from the shared template, the
# shared operating prompt, and the Claude-specific tooling paragraph.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/.claude/agents"
CHROMIUM_DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in one shared fingerprint-Chromium process. Each context uses about 100–200 MB with the 2-tab cap; keep fan-outs to about 10 concurrent agents. Contexts idle for 5 minutes are released; relaunch when browser work resumes."
FIREFOX_DESCRIPTION="Headless-Firefox swarm agent for sites where Chromium is blocked but Firefox renders (Akamai, notably). Owns a cheap isolated context on one shared Firefox process. Use plain browser-swarm unless the site is confirmed to block Chromium. Contexts idle for 5 minutes are released; relaunch when browser work resumes."
TEMPLATE="$DIR/claude-agents/browser-swarm.template.md"
PROMPT="$(mktemp)"
trap 'rm -f "$PROMPT"' EXIT

splice() { awk -v file="$2" '$0 == $ENVIRON["MARKER"] { while ((getline line < file) > 0) print line; close(file); next } 1' "$1"; }

MARKER=__TOOLING__ splice "$DIR/agent-prompt.md" "$DIR/claude-agents/tooling.md" > "$PROMPT"

render() {
  local name="$1" description="$2" backend="$3"
  local destination="$AGENTS/$name.md"
  MARKER=__PROMPT__ splice "$TEMPLATE" "$PROMPT" \
    | sed -e "s|__DIR__|$DIR|g" -e "s|__NAME__|$name|g" \
      -e "s|__DESCRIPTION__|$description|g" -e "s|__BACKEND__|$backend|g" \
    > "$destination"
  echo "wrote $destination"
}

mkdir -p "$AGENTS"
render browser-swarm "$CHROMIUM_DESCRIPTION" ""
render browser-swarm-firefox "$FIREFOX_DESCRIPTION" " firefox"
