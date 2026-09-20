# Codex agent definitions

```sh
./install-agents.sh
```

Requires the Codex CLI. Registers `playwright` in the parent Codex configuration as `swarm mcp chromium`, this checkout's stdio adapter, and generates `browser-swarm` from `browser-swarm.template.toml`, the shared [operating prompt](../agent-prompt.md) and the Codex tooling paragraph in [tooling.md](tooling.md). Both files live under `CODEX_HOME` (default `~/.codex`). Run it again after moving the checkout, then start a new Codex session.

Codex agents use MCP rather than the `swarm` CLI because Codex's command sandbox blocks all network access. Each MCP session owns one context in the shared controller and closes it on `browser_close`, on session end, or after five idle minutes excluding time with a request in flight.

MCP servers and permissions come from the parent session; custom roles cannot override them. Browser tools are available to the parent and all its children, with a separate MCP process per session. Spawn the custom agent type with `fork_turns: "none"`; a full-history fork inherits the parent agent type and cannot select this definition.

Verify the integration in a fresh session:

```sh
codex exec 'Spawn one browser-swarm agent with fork_turns none. Have it call browser_tabs with action list, then report the result. Do not navigate. Wait for its answer.'
```
