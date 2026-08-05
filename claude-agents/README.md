# Claude Code agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm-1` … `browser-swarm-10` into `~/.claude/agents/` from `browser-swarm.template.md`, with this checkout's path and your `node` substituted in and the shared system prompt ([../agent-prompt.md](../agent-prompt.md)) spliced in. Run it again after moving the checkout.

The ten siblings are identical except for their name and the agent-tag argument to the MCP launcher, and that difference is load-bearing: Claude Code shares one MCP server between concurrent subagents whose configs match byte for byte, which collapses them into one browser context fighting over one tab. See [../docs/claude-code-mcp-dedup.md](../docs/claude-code-mcp-dedup.md).

**One concurrent invocation per type.** Assign types round-robin across a fan-out; two agents on the same type still share a browser. Raise `SWARM_SIZE` in the script for a wider fan-out.

An initialized agent's MCP session closes after five minutes without activity. Relaunch the agent when browser tools are needed again; the fresh session gets a fresh isolated context.

`browser-swarm-firefox.md` is a separate, hand-edited example: headless Firefox for the sites that block Chromium ([../docs/bot-detection.md](../docs/bot-detection.md)). Its launcher ([../firefox-mcp.sh](../firefox-mcp.sh)) starts a supervised private browser instead of attaching to the daemon, because CDP is Chromium-only, and the definition carries its own copy of the prompt without the daemon rules. Fill in the launcher and Node.js paths before using it.
