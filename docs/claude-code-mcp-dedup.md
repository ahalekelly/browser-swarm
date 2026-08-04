# Claude Code shares inline MCP servers by name across concurrent subagents

Concurrent Claude Code subagents whose frontmatter declares an inline MCP server under the **same name** can end up served by one MCP client session. For a Playwright MCP server that means one browser context and one contested tab list: every subagent's `browser_navigate` retargets the same tab, clobbering the others.

The server name is the key, and a shared name gives no isolation guarantee — though not every same-named pair shares. What the probes and incident forensics pin down: byte-identical configs share one session; a subagent spawned by an agent that already holds a same-named session joins that session whatever its own config says, so in a nested fan-out a `browser-swarm-1` leaf lands on its parent's `playwright` session, launcher tag and all; and a running agent's calls can migrate between same-named server processes as agents around it start and finish. A flat fan-out of same-named siblings with distinct launcher arguments can come up isolated — which is why the argument-only workaround looked sufficient until nested spawns collapsed it.

Verified on Claude Code 2.1.221 with `@playwright/mcp` 0.0.78.

## The workaround

Give every definition that may run concurrently its own server name. The sibling agents in [`claude-agents/`](../claude-agents/) declare `playwright1` … `playwright5` and pass a matching per-type tag to the MCP launcher (which also names the session's `--output-dir`, keeping the MCP's artifact droppings out of the working directory). The Firefox variant declares `firefox`.

Two probes settle it, each a parent subagent that navigates to a marker page, spawns a child subagent that navigates to a different marker, then lists its own tabs:

- Both servers named `playwright`, distinct launcher tags: the child's calls are served by the *parent's* server process, and the parent's tab list comes back showing the child's page.
- Servers named `pwparentb` and `pwchildb`: each agent gets its own server process, its own browser context, and a tab list holding only its own page.

Two things this costs:

- **Concurrency is capped at the number of sibling types.** Two concurrent invocations of the *same* type share one name, so the orchestrator assigns types round-robin — counting every swarm agent alive in the Claude Code session, since nested fan-outs (several orchestrators each spawning leaves) oversubscribe the pool silently. More siblings can be added mechanically by raising `SWARM_SIZE`.
- **Type assignment needs a single allocator.** Subagents cannot see which types their siblings picked, so nested orchestrators that allocate independently collide deterministically: in one observed session, the parent and three concurrent orchestrator subagents each started at `browser-swarm-1`, and every duplicated type produced bidirectional tab contamination — each agent read the other's pages, misdiagnosed downstream as ad injection and as a daemon isolation bug. A parent that fans browser work out through multiple subagents must write an explicit disjoint type range into each one's prompt.
- **The files must stay in sync, and their server names must stay different.** Normalizing the names back to one silently reintroduces the shared browser.

## Recognising a shared session

The daemon isolates correctly — one MCP client session gets one Chromium browser context, and pages other CDP clients open are invisible to it — so cross-agent tab traffic always means two agents landed on one MCP session, never a leak between contexts.

Every snapshot and console link in a tool result is a path into the serving process's output dir, `/tmp/claude/pwmcp-swarm-<tag>-<pid>`. An agent whose results cite a tag that is not its own is being served by another agent's session; the same paths in a saved transcript reconstruct after the fact which agents shared which server process.

Related upstream reports: [playwright-mcp#893](https://github.com/microsoft/playwright-mcp/issues/893) describes the symptom, parallel Claude Code agents "fighting over the same tab despite `--isolated`", with no root cause identified. [claude-code#28126](https://github.com/anthropics/claude-code/issues/28126) reports the opposite — per-subagent duplicate servers — on Windows.

If Claude Code later gives each subagent its own connection, the distinct names stay harmless.
