#!/bin/bash
# Generate both BrowserSwarm agent definitions from the shared template.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
CHROMIUM_DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in one shared fingerprint-Chromium process. Each context uses about 100–200 MB with the 2-tab cap; keep fan-outs to about 10 concurrent agents. The daemon auto-starts, and the first agent after a crash reports it and asks to be relaunched. Sessions idle for 5 minutes are reaped; relaunch when browser work resumes."
FIREFOX_DESCRIPTION="Headless-Firefox swarm agent for sites where Chromium is blocked but Firefox renders (Akamai, notably). Owns a cheap isolated context on one shared Firefox process. Use plain browser-swarm unless the site is confirmed to block Chromium. Sessions idle for 5 minutes are reaped; relaunch when browser work resumes."
TEMPLATE="$DIR/claude-agents/browser-swarm.template.md"

mkdir -p "$AGENTS"

render() {
  local name="$1" description="$2" server_name="$3" browser="$4"
  local destination="$AGENTS/$name.md"
  awk -v prompt="$DIR/agent-prompt.md" '$0 == "__PROMPT__" { while ((getline line < prompt) > 0) print line; next } 1' "$TEMPLATE" \
    | sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" \
      -e "s|__NAME__|$name|g" -e "s|__DESCRIPTION__|$description|g" \
      -e "s|__SERVER_NAME__|$server_name|g" -e "s|__BROWSER__|$browser|g" \
    > "$destination"
  echo "wrote $destination"
}

render browser-swarm "$CHROMIUM_DESCRIPTION" playwright chromium
render browser-swarm-firefox "$FIREFOX_DESCRIPTION" firefox firefox
