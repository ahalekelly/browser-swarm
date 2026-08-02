# Claude Code agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm-1` … `browser-swarm-5` into `~/.claude/agents/` from `browser-swarm.template.md`, with this checkout's path and your `node` substituted in and the shared system prompt ([../agent-prompt.md](../agent-prompt.md)) spliced in. Run it again after moving the checkout.

The five siblings are identical except for their name and the agent-tag argument to the MCP launcher, and that difference is load-bearing: Claude Code shares one MCP server between concurrent subagents whose configs match byte for byte, which collapses them into one browser context fighting over one tab. See [../docs/claude-code-mcp-dedup.md](../docs/claude-code-mcp-dedup.md).

**One concurrent invocation per type.** Assign types round-robin across a fan-out; two agents on the same type still share a browser. Raise `SWARM_SIZE` in the script for a wider fan-out.

`browser-swarm-firefox.md` is a separate, hand-edited example: headless Firefox for the sites that block Chromium ([../docs/bot-detection.md](../docs/bot-detection.md)). It launches its own browser instead of attaching to the daemon, because CDP is Chromium-only, and so it carries its own copy of the prompt without the daemon rules. Fill in the two paths before using it.
