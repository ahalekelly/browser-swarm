#!/bin/bash
# Generate the BrowserSwarm agent definition into ~/.codex/agents/.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.codex/agents"
TEMPLATE="$DIR/codex-agents/browser-swarm.template.toml"

mkdir -p "$AGENTS"
sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" "$TEMPLATE" > "$AGENTS/browser-swarm.toml"
echo "wrote $AGENTS/browser-swarm.toml"
