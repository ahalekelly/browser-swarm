#!/bin/bash
# Generate the BrowserSwarm agent definition into ~/.codex/agents/.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/agent-paths.sh"
require_safe_agent_path "BrowserSwarm checkout" "$DIR"
if ! NODE="$(command -v node)"; then
  echo "ERROR: Node.js is required to install the Codex agents" >&2
  exit 1
fi
require_safe_agent_path "Node.js executable" "$NODE"
AGENTS="$HOME/.codex/agents"
TEMPLATE="$DIR/codex-agents/browser-swarm.template.toml"

mkdir -p "$AGENTS"
sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" "$TEMPLATE" > "$AGENTS/browser-swarm.toml"
echo "wrote $AGENTS/browser-swarm.toml"
