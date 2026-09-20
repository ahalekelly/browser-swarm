# Claude Code agent definitions

```sh
./install-agents.sh
```

Generates `browser-swarm` and `browser-swarm-firefox` in `~/.claude/agents/`, with this checkout's path substituted into the template. Each splices the shared operating prompt from [agent-prompt.md](../agent-prompt.md) and the Claude tooling paragraph from [tooling.md](tooling.md), which tells the agent to drive the browser with the `swarm` CLI from Bash. Run the installer again after moving the checkout.

The definitions declare no MCP server, so any number of them can run at once. Both withhold the `Agent` tool: a browser task is cheap to do and expensive to delegate.

Use `browser-swarm-firefox` only for sites confirmed to block Chromium. It gets an isolated context on one shared Playwright Firefox process.

Keep fan-outs to about 10 concurrent agents. Each context uses roughly 100–200 MB with the 2-tab cap. Contexts are released after five idle minutes; relaunch when browser work resumes.

Verify the integration from a Claude Code session:

```sh
id=$(<checkout>/swarm open) && <checkout>/swarm "$id" tabs '{"action":"list"}' && <checkout>/swarm "$id" close
```
