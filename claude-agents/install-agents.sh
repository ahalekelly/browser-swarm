#!/bin/bash
# Generate the sibling browser-swarm agent definitions into ~/.claude/agents/.
# The siblings exist because Claude Code deduplicates inline MCP server configs
# by content across concurrent subagents (docs/claude-code-mcp-dedup.md), so
# each one's --output-dir must stay distinct. Generating them keeps that true.
set -euo pipefail

SWARM_SIZE=5
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
TEMPLATE="$DIR/claude-agents/browser-swarm.template.md"
PRIMARY_DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in the shared headless browser daemon, which auto-starts on first use (after a crash it refuses, and the orchestrator must run $DIR/shared-browser.sh start). Only one concurrent invocation per agent type — Claude Code shares identical inline MCP server configs across concurrent subagents, so run parallel agents on distinct types (browser-swarm, browser-swarm-2 … browser-swarm-5, one type per concurrent agent)."
SECONDARY_DESCRIPTION="Additional browser-swarm concurrency slot with a distinct MCP session. See browser-swarm for usage."

mkdir -p "$AGENTS"
for n in $(seq 1 "$SWARM_SIZE"); do
  # The first agent is the plain `browser-swarm` type; the rest carry their number.
  if [ "$n" = 1 ]; then
    SUFFIX=""
    DESCRIPTION="$PRIMARY_DESCRIPTION"
  else
    SUFFIX="-$n"
    DESCRIPTION="$SECONDARY_DESCRIPTION"
  fi
  sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__SUFFIX__|$SUFFIX|g" -e "s|__N__|$n|g" -e "s|__DESCRIPTION__|$DESCRIPTION|g" \
    "$TEMPLATE" > "$AGENTS/browser-swarm$SUFFIX.md"
  echo "wrote $AGENTS/browser-swarm$SUFFIX.md"
done
