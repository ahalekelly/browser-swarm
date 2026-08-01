# Codex agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm` into `~/.codex/agents/` from `browser-swarm.template.toml`, with this checkout's path and the active Node.js path substituted in. Run it again after moving the checkout.

Codex can invoke the same agent definition concurrently. Each invocation owns a separate Playwright MCP session, isolated browser context, and persistent temporary output directory. Spawn the custom agent type with `fork_turns: "none"`; a full-history fork inherits the parent agent type and cannot select this definition.

An invocation's MCP session is reaped after five idle minutes, excluding time with an MCP request in flight. Relaunch the agent when browser access is needed again.
