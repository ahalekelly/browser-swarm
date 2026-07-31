# Codex agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm` into `~/.codex/agents/` from `browser-swarm.template.toml`, with this checkout's path and the active Node.js path substituted in. Run it again after moving the checkout.

Codex can invoke the same agent definition concurrently. Each invocation owns a separate Playwright MCP session and isolated browser context.
