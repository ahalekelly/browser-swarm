#!/bin/bash
# Generate the sibling BrowserSwarm agent definitions into ~/.codex/agents/.
set -euo pipefail

SWARM_SIZE=5
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.codex/agents"
TEMPLATE="$DIR/codex-agents/browser-swarm.template.toml"
PRIMARY_DESCRIPTION="Headless-browser swarm agent for background web automation such as lookups, extraction, and form-driven flows. Owns a private isolated context in the shared headless browser daemon. Use distinct browser-swarm slots for parallel agents so each has its own MCP output directory."
SECONDARY_DESCRIPTION="Additional BrowserSwarm concurrency slot with a distinct MCP session and output directory. See browser-swarm-1 for usage."

mkdir -p "$AGENTS"
for n in $(seq 1 "$SWARM_SIZE"); do
  if [ "$n" = 1 ]; then DESCRIPTION="$PRIMARY_DESCRIPTION"; else DESCRIPTION="$SECONDARY_DESCRIPTION"; fi
  sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__N__|$n|g" -e "s|__DESCRIPTION__|$DESCRIPTION|g" \
    "$TEMPLATE" > "$AGENTS/browser-swarm-$n.toml"
  echo "wrote $AGENTS/browser-swarm-$n.toml"
done
