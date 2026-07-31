# Codex agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm-1` through `browser-swarm-5` into `~/.codex/agents/` from `browser-swarm.template.toml`, with this checkout's path and the active Node.js path substituted in. Run it again after moving the checkout.

Use distinct slots in a parallel fan-out. Each slot owns a separate Playwright MCP output directory and an isolated browser context.
