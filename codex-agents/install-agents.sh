#!/bin/bash
# Register BrowserSwarm in the parent Codex config and generate its agent, splicing
# the shared system prompt (../agent-prompt.md) into the TOML template. The
# prompt lands inside a TOML """ string, so it must stay free of backslashes
# and triple quotes.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CODEX="$(command -v codex)"
AGENTS="${CODEX_HOME:-$HOME/.codex}/agents"
TEMPLATE="$DIR/codex-agents/browser-swarm.template.toml"

"$CODEX" mcp add playwright -- "$NODE" "$DIR/src/launch.ts" chromium
mkdir -p "$AGENTS"
awk -v prompt="$DIR/agent-prompt.md" '$0 == "__PROMPT__" { while ((getline line < prompt) > 0) print line; next } 1' "$TEMPLATE" \
  | sed -e "s|__DIR__|$DIR|g" > "$AGENTS/browser-swarm.toml"
echo "wrote $AGENTS/browser-swarm.toml"
