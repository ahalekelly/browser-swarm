#!/bin/bash
# Generate the sibling browser-swarm agent definitions into ~/.claude/agents/,
# splicing the shared system prompt (../agent-prompt.md) into the template.
# The siblings exist because Claude Code shares one MCP session between
# concurrent subagents whose inline servers carry the same name
# (docs/claude-code-mcp-dedup.md), so each sibling declares its own server name
# — playwright1 … playwright10 — plus its own launcher tag. Generating them keeps
# both distinct.
set -euo pipefail

SWARM_SIZE=10
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/.claude/agents"
TEMPLATE="$DIR/claude-agents/browser-swarm.template.md"
PRIMARY_DESCRIPTION="Headless-browser swarm agent for background web automation (lookups, extractions, form-driven flows). Owns a private isolated context in the shared headless browser daemon, which auto-starts on first use — even after a crash, though the first agent attaching after one comes up without browser tools and reports the crash (relaunch that agent). Only one concurrent invocation per agent type — same-type agents share one browser context and fight over its tabs, so run parallel agents on distinct types (browser-swarm-1 … browser-swarm-10, one type per concurrent agent), counting every swarm agent alive anywhere in the session rather than only your own fan-out. Subagents cannot see which types their siblings picked, so a parent fanning browser work out through multiple concurrent orchestrator subagents must write a disjoint type range into each one's prompt. Sessions idle for 5 minutes are reaped — relaunch the agent when browser work resumes."
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
