#!/bin/bash
# Register BrowserSwarm's MCP adapter in the parent Codex config and generate
# its agent, splicing the shared operating prompt and the Codex tooling
# paragraph into the TOML template. The prompt lands inside a TOML """ string,
# so it must stay free of backslashes and triple quotes.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CODEX="$(command -v codex)"
AGENTS="${CODEX_HOME:-$HOME/.codex}/agents"
TEMPLATE="$DIR/codex-agents/browser-swarm.template.toml"
PROMPT="$(mktemp)"
trap 'rm -f "$PROMPT"' EXIT

# splice <marker> <file> <insert>: print <file> with the marker line replaced
# by the contents of <insert>.
splice() { awk -v marker="$1" -v insert="$3" '$0 == marker { while ((getline line < insert) > 0) print line; close(insert); next } 1' "$2"; }

"$CODEX" mcp add playwright -- "$NODE" "$DIR/src/cli.ts" mcp chromium
mkdir -p "$AGENTS"
splice __TOOLING__ "$DIR/agent-prompt.md" "$DIR/codex-agents/tooling.md" > "$PROMPT"
splice __PROMPT__ "$TEMPLATE" "$PROMPT" | sed -e "s|__DIR__|$DIR|g" > "$AGENTS/browser-swarm.toml"
echo "wrote $AGENTS/browser-swarm.toml"
