#!/bin/bash
# Generate the sibling browser-swarm agent definitions into ~/.claude/agents/,
# splicing the shared system prompt (../agent-prompt.md) into the template.
# The siblings exist because Claude Code deduplicates inline MCP server configs
# by content across concurrent subagents (docs/claude-code-mcp-dedup.md), so
# each one's launcher argument must stay distinct. Generating them keeps that true.
set -euo pipefail

SWARM_SIZE=5
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
TEMPLATE="$DIR/claude-agents/browser-swarm.template.md"
PRIMARY_DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in the shared headless browser daemon, which auto-starts on first use — even after a crash, though the first agent attaching after one comes up without browser tools and reports the crash (relaunch that agent). Only one concurrent invocation per agent type — Claude Code shares identical inline MCP server configs across concurrent subagents, so run parallel agents on distinct types (browser-swarm-1 … browser-swarm-5, one type per concurrent agent, counted across the whole session). Subagents cannot see which types their siblings picked, so when browser work fans out through multiple concurrent orchestrator subagents, the parent must write a disjoint type range into each one's prompt — colliding types silently share one browser context whose tabs clobber each other. Sessions idle for 5 minutes are reaped — relaunch the agent when browser work resumes."
SECONDARY_DESCRIPTION="Additional browser-swarm concurrency slot with a distinct MCP session. See browser-swarm-1 for usage."

mkdir -p "$AGENTS"
for n in $(seq 1 "$SWARM_SIZE"); do
  # browser-swarm-1 carries the full description; the rest point back to it.
  if [ "$n" = 1 ]; then DESCRIPTION="$PRIMARY_DESCRIPTION"; else DESCRIPTION="$SECONDARY_DESCRIPTION"; fi
  awk -v prompt="$DIR/agent-prompt.md" '$0 == "__PROMPT__" { while ((getline line < prompt) > 0) print line; next } 1' "$TEMPLATE" \
    | sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__N__|$n|g" -e "s|__DESCRIPTION__|$DESCRIPTION|g" \
    > "$AGENTS/browser-swarm-$n.md"
  echo "wrote $AGENTS/browser-swarm-$n.md"
done
