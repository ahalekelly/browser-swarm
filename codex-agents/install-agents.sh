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

splice() { awk -v file="$2" '$0 == $ENVIRON["MARKER"] { while ((getline line < file) > 0) print line; close(file); next } 1' "$1"; }

"$CODEX" mcp add playwright -- "$NODE" "$DIR/src/cli.ts" mcp chromium
mkdir -p "$AGENTS"
MARKER=__TOOLING__ splice "$DIR/agent-prompt.md" "$DIR/codex-agents/tooling.md" > "$PROMPT"
MARKER=__PROMPT__ splice "$TEMPLATE" "$PROMPT" | sed -e "s|__DIR__|$DIR|g" > "$AGENTS/browser-swarm.toml"
echo "wrote $AGENTS/browser-swarm.toml"
