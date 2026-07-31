#!/bin/bash
# Generate the sibling browser-leaf agent definitions into ~/.claude/agents/.
# The siblings exist because Claude Code deduplicates inline MCP server configs
# by content across concurrent subagents (docs/claude-code-mcp-dedup.md), so
# each one's --output-dir must stay distinct. Generating them keeps that true.
set -euo pipefail

LEAVES=5
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
TEMPLATE="$DIR/examples/claude-code/browser-leaf.template.md"

mkdir -p "$AGENTS"
for n in $(seq 1 "$LEAVES"); do
  # The first leaf is the plain `browser-leaf` type; the rest carry their number.
  [ "$n" = 1 ] && SUFFIX="" || SUFFIX="-$n"
  sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__SUFFIX__|$SUFFIX|g" -e "s|__N__|$n|g" \
    "$TEMPLATE" > "$AGENTS/browser-leaf$SUFFIX.md"
  echo "wrote $AGENTS/browser-leaf$SUFFIX.md"
done
