# Claude Code agent definitions

```sh
./install-agents.sh
```

Generates `browser-leaf`, `browser-leaf-2` … `browser-leaf-5` into `~/.claude/agents/` from `browser-leaf.template.md`, with this checkout's path and your `node` substituted in. Run it again after moving the checkout.

The five siblings are identical except for their name and `--output-dir`, and that difference is load-bearing: Claude Code shares one MCP server between concurrent subagents whose configs match byte for byte, which collapses them into one browser context fighting over one tab. See [../docs/claude-code-mcp-dedup.md](../docs/claude-code-mcp-dedup.md).

**One concurrent invocation per type.** Assign types round-robin across a fan-out; two leaves on the same type still share a browser. Raise `LEAVES` in the script for a wider fan-out.

`browser-leaf-firefox.md` is a separate, hand-edited example: headless Firefox for the sites that block Chromium ([../docs/bot-detection.md](../docs/bot-detection.md)). It launches its own browser instead of attaching to the daemon, because CDP is Chromium-only. Fill in the two paths before using it.
