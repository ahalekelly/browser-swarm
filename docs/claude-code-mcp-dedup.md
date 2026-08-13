# Claude Code shares inline MCP servers by name across concurrent subagents

Stock Claude Code can route concurrent subagents whose frontmatter declares the same inline MCP server name through one MCP client session. For Playwright MCP, those agents share one browser context and contest one tab list despite `--isolated`.

The server name is the key. Byte-identical configs share one session; nested subagents can join a parent's same-named session even when launcher arguments differ; and calls can migrate between same-named server processes as surrounding agents start and finish. These behaviors were verified on Claude Code 2.1.221 with `@playwright/mcp` 0.0.78 and are tracked upstream in [claude-code#84638](https://github.com/anthropics/claude-code/issues/84638).

## Local fix

The [`mcp-per-subagent`](https://github.com/ahalekelly/claude-patching) patch gives every subagent its own stdio MCP server process and stamps `CLAUDE_MCP_PER_AGENT=1` into that server's environment. BrowserSwarm therefore ships one reusable `browser-swarm` definition with server name `playwright`; every invocation gets a distinct MCP process, output directory, and isolated browser context.

`src/launch.ts` enforces the patch as a canary. When `CLAUDECODE=1` without `CLAUDE_MCP_PER_AGENT=1`, it leaves either browser daemon untouched and exposes installation instructions through the session's sole `browser_swarm_error` MCP tool. Stock Claude Code gets a loud refusal rather than silent context sharing. Codex does not set `CLAUDECODE`, so the check does not apply there.

When upstream fixes #84638, only this canary needs removal. The single reusable agent and per-invocation isolated contexts remain the intended design.

## Evidence

Two nested probes established the failure mode. A parent navigated to one marker, spawned a child that navigated to another, then listed its tabs:

- With both inline servers named `playwright`, the child's calls ran through the parent's server process and replaced the parent's page.
- With distinct server names, each agent retained its own process, context, and marker page.

Daemon isolation was not the source. One MCP connection gets one isolated context, and pages opened by other connections are invisible. Tabs an agent did not open therefore indicate broken MCP process isolation; the agent prompt treats that as a bug and tells the worker to stop.

Related report: [playwright-mcp#893](https://github.com/microsoft/playwright-mcp/issues/893) describes parallel agents fighting over one tab despite `--isolated`.
