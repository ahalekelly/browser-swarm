#!/bin/bash
# Generate the Chromium and Firefox BrowserSwarm agent definitions, splicing
# the shared system prompt into both templates.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in one shared fingerprint-Chromium process. Each context uses about 100–200 MB with the 2-tab cap; keep fan-outs to about 10 concurrent agents. The daemon auto-starts, and the first agent after a crash reports it and asks to be relaunched. Sessions idle for 5 minutes are reaped; relaunch when browser work resumes."

mkdir -p "$AGENTS"
node - "$AGENTS" <<'NODE'
const { readdirSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const [agents] = process.argv.slice(2);
for (const name of readdirSync(agents)) {
  if (/^browser-swarm-\d+\.md$/.test(name)) {
    unlinkSync(join(agents, name));
    console.log(`deleted stale ${join(agents, name)}`);
  }
}
NODE

render() {
  local template="$1" destination="$2"
  awk -v prompt="$DIR/agent-prompt.md" '$0 == "__PROMPT__" { while ((getline line < prompt) > 0) print line; next } 1' "$template" \
    | sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__DESCRIPTION__|$DESCRIPTION|g" \
    > "$destination"
  echo "wrote $destination"
}

render "$DIR/claude-agents/browser-swarm.template.md" "$AGENTS/browser-swarm.md"
render "$DIR/claude-agents/browser-swarm-firefox.template.md" "$AGENTS/browser-swarm-firefox.md"
