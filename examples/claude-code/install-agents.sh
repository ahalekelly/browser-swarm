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
PRIMARY_DESCRIPTION="Headless-browser leaf agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in the shared headless browser daemon (start it first: $DIR/shared-browser.sh start), but only one concurrent invocation per leaf type — Claude Code shares identical inline MCP server configs across concurrent subagents, so run parallel leaves on distinct types (browser-leaf, browser-leaf-2 … browser-leaf-5, one type per concurrent leaf)."
SECONDARY_DESCRIPTION="Additional browser-leaf concurrency slot with a distinct MCP session. See browser-leaf for usage."

mkdir -p "$AGENTS"
for n in $(seq 1 "$LEAVES"); do
  # The first leaf is the plain `browser-leaf` type; the rest carry their number.
  if [ "$n" = 1 ]; then
    SUFFIX=""
    DESCRIPTION="$PRIMARY_DESCRIPTION"
  else
    SUFFIX="-$n"
    DESCRIPTION="$SECONDARY_DESCRIPTION"
  fi
  sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__SUFFIX__|$SUFFIX|g" -e "s|__N__|$n|g" -e "s|__DESCRIPTION__|$DESCRIPTION|g" \
    "$TEMPLATE" > "$AGENTS/browser-leaf$SUFFIX.md"
  echo "wrote $AGENTS/browser-leaf$SUFFIX.md"
done
