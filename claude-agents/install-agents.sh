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

# splice <marker> <file> <insert>: print <file> with the marker line replaced
# by the contents of <insert>.
splice() { awk -v marker="$1" -v insert="$3" '$0 == marker { while ((getline line < insert) > 0) print line; close(insert); next } 1' "$2"; }

splice __TOOLING__ "$DIR/agent-prompt.md" "$DIR/claude-agents/tooling.md" > "$PROMPT"

render() {
  local name="$1" description="$2" backend="$3"
  local destination="$AGENTS/$name.md"
  splice __PROMPT__ "$TEMPLATE" "$PROMPT" \
    | sed -e "s|__DIR__|$DIR|g" -e "s|__NAME__|$name|g" \
      -e "s|__DESCRIPTION__|$description|g" -e "s|__BACKEND__|$backend|g" \
    > "$destination"
  echo "wrote $destination"
}

mkdir -p "$AGENTS"
render browser-swarm "$CHROMIUM_DESCRIPTION" ""
render browser-swarm-firefox "$FIREFOX_DESCRIPTION" " firefox"
