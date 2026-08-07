# Claude Code agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm` and `browser-swarm-firefox` in `~/.claude/agents/`, with this checkout's path and active Node.js path substituted into the templates. Both splice in the shared system prompt from [agent-prompt.md](../agent-prompt.md). Run the installer again after moving the checkout.

The installer removes stale numbered `browser-swarm-1` … `browser-swarm-10` files. The local Claude Code [`mcp-per-subagent`](https://github.com/ahalekelly/claude-patching) patch makes one reusable definition safe for concurrent subagents; the launcher refuses unpatched sessions. See [Claude Code inline MCP server sharing](../docs/claude-code-mcp-dedup.md).

Use `browser-swarm-firefox` only for sites confirmed to block Chromium. It gets an isolated context on one shared Playwright Firefox process.

Keep fan-outs to about 10 concurrent agents. Each context uses roughly 100–200 MB with the 2-tab cap. Sessions close after five idle minutes; relaunch when browser work resumes.
