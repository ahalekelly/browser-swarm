# Codex agent definitions

```sh
./install-agents.sh
```

Requires the Codex CLI. Registers `playwright` in the parent Codex configuration using the active Node.js executable and this checkout's launcher. Generates `browser-swarm` from `browser-swarm.template.toml` and the shared [operating prompt](../agent-prompt.md). Both files live under `CODEX_HOME` (default `~/.codex`). Run it again after moving the checkout, then start a new Codex session.

MCP servers and permissions come from the parent session; custom roles cannot override them. Browser tools are available to the parent and all its children, with a separate MCP process per session. The role's read-only browsing instructions guide behavior; filesystem access follows the parent's permissions.

Codex can invoke the same agent definition concurrently. Each invocation owns a separate Playwright MCP session, isolated browser context, and private output directory. Spawn the custom agent type with `fork_turns: "none"`; a full-history fork inherits the parent agent type and cannot select this definition.

An invocation's MCP session is reaped after five idle minutes, excluding time with a request in flight. Relaunch the agent when browser access is needed again.

Verify the integration in a fresh session:

```sh
codex exec 'Spawn one browser-swarm agent with fork_turns none. Have it call browser_tabs with action list, then report the result. Do not navigate. Wait for its answer.'
```
