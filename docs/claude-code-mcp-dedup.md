# Claude Code deduplicates inline MCP servers across concurrent subagents

Concurrent Claude Code subagents whose frontmatter declares a **byte-identical** MCP server config share one stdio server process and one MCP session. For a Playwright MCP server that means one browser context and one contested tab list: every subagent's `browser_navigate` retargets the same tab, clobbering the others.

Verified on Claude Code 2.1.220 with `@playwright/mcp` 0.0.78.

## Why it happens

The dedup is keyed on config *content*, not agent type — four different agent types with byte-identical Playwright configs still share one server. This contradicts the documented behavior, which says inline servers are "connected when the subagent starts and disconnected when it finishes."

`@playwright/mcp` with `--isolated` creates one browser context per *MCP client session*, and a stdio server has exactly one client session. When N subagents are multiplexed over that single session, they all operate on the same context. `--isolated` cannot help here — the isolation boundary it keys on is the thing that got collapsed. Cross-process browser sharing is impossible in this mode, since an isolated MCP server launches a fresh browser per server process, which pins the sharing on Claude Code's connection layer rather than on Playwright.

Related upstream reports: [playwright-mcp#893](https://github.com/microsoft/playwright-mcp/issues/893) describes exactly this symptom, parallel Claude Code agents "fighting over the same tab despite `--isolated`", with no root cause identified. [claude-code#28126](https://github.com/anthropics/claude-code/issues/28126) reports the opposite — per-subagent duplicate servers — on Windows.

## The workaround

Make each concurrent subagent's server config unique. The sibling agent definitions in [`claude-agents/`](../claude-agents/) are identical except for `name:` and a per-type `--output-dir`, which is enough to defeat the dedup (and also moves the MCP's artifact droppings out of the working directory).

Verified at 5× concurrency: five subagents on five distinct sites, each listing its full tab set three times at 15s intervals, gave 15/15 clean listings — no agent ever saw another's tab — against five separate server processes.

Two things this costs:

- **Concurrency is capped at the number of sibling types.** Two concurrent invocations of the *same* type still share a browser, so the orchestrator must assign types round-robin. More siblings can be added mechanically.
- **The files must stay in sync, and their configs must stay different.** Normalizing the `--output-dir` values to match silently reintroduces the shared browser.

If Claude Code later makes per-instance connections match the documentation, the unique configs stay harmless.
