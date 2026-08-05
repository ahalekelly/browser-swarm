# BrowserSwarm

One long-lived headless browser, shared by every agent in a fan-out.

Give an agent workflow a Playwright MCP server and each subagent launches its own browser. Ten parallel subagents is ten browser instances, and that is several gigabytes of renderer processes and a frozen machine. This repo replaces that with a single browser daemon on a fixed CDP port; each agent attaches as its own isolated browser context, with its own cookies, storage, and tabs.

This uses [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) to imitate a real user so it doesn't get automatically blocked.

The MCP tools and wire protocol come from the standard pinned [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp). A transparent stdio supervisor gives each MCP session a five-minute inactivity lease; it forwards the pinned server's protocol unchanged and owns only that server process's lifetime. The repo also adds the daemon that makes sharing one browser safe, plus the agent definitions and operating rules for an agent fan-out.

macOS on Apple silicon only. The daemon uses `taskpolicy`, `lsof`, and a pinned macOS arm64 browser build.

## Install

One command, clones to `~/.browser-swarm`, installs the pinned Playwright MCP and browser, and generates the Claude Code agent definitions:

```sh
npx browser-swarm
```

Or from a clone, run the pieces yourself:

```sh
git clone https://github.com/ahalekelly/browser-swarm.git
cd browser-swarm
npm ci                              # pinned @playwright/mcp
./install-fingerprint-chromium.sh   # one-time browser install, checksum-verified
./claude-agents/install-agents.sh   # generate the agent definitions
./codex-agents/install-agents.sh
```

## Use

The daemon auto-starts when a swarm agent attaches (see the crash rules below), so routine fan-outs need no manual step. The verbs:

```sh
./shared-browser.sh start   # idempotent — exit 0 if our daemon is already up
./shared-browser.sh status  # pid + watchdog + attached clients + open pages + crash state
./shared-browser.sh stop    # rarely needed; the watchdog stops idle daemons
```

Point any Playwright MCP instance at it:

```
--cdp-endpoint http://localhost:9377 --isolated
```

`--isolated` is mandatory, and it composes with `--cdp-endpoint` rather than replacing it. With `--cdp-endpoint` alone every attached instance lands in the browser's default context and they hijack each other's tabs; adding `--isolated` gives each instance its own context.

Both scripts must run outside any sandbox — Chromium can't write its crashpad and profile files inside one, and a sandbox with no network can't fetch the browser.

The tests use fake browsers and MCPs on loopback ports and never touch the installed daemon; run them outside a sandbox too (they bind loopback):

```sh
npm test
```

## Agent definitions

[`claude-agents/`](claude-agents/) holds ten sibling Claude Code subagent definitions (`browser-swarm-1` … `browser-swarm-10`), while [`codex-agents/`](codex-agents/) holds one reusable Codex custom-agent definition (`browser-swarm`). Their `install-agents.sh` scripts generate the definitions into `~/.claude/agents/` and `~/.codex/agents/`; the npx install runs both. The Claude directory also includes a launched-mode Firefox variant for sites where Chromium is blocked, copied by hand.

The Claude definitions must be ten near-identical files rather than one because Claude Code deduplicates inline MCP server configs by content across concurrent subagents — see [docs/claude-code-mcp-dedup.md](docs/claude-code-mcp-dedup.md). Codex launches a separate MCP session and isolated browser context for each invocation of the reusable definition.

The system prompt in those files is spliced in from [agent-prompt.md](agent-prompt.md), the single source for the operating rules that matter in practice: headless only, read-only unless the task explicitly authorizes otherwise, writes confined to a temp output dir, and the tab cap below.

## Operating rules

**At most 2 open tabs per context, closed as soon as their content is extracted.** Every open tab holds a renderer process and hundreds of megabytes; a 14-tab session reached ~6 GB RSS and froze the machine. This is the single most important rule for anything that attaches.

**Reach for a browser last.** A purpose-built MCP or API first, then web search, which on most sites returns page text and so covers plain reading. A browser is the right tool for interaction — forms, carts, configurators, authenticated flows — and for sites that starve the cheaper paths, where search sees only a page title and a plain fetch gets a body-less shell. It costs far more tokens and wall-clock than either, and it is the only path a bot wall can block.

**Relaunch an agent after an idle disconnect.** An initialized MCP session closes after five minutes without MCP activity. Browser agents are disposable: if browser tools are needed after that gap, the orchestrator launches a fresh agent with a fresh isolated context.

**One concurrent invocation per numbered type, allocated by a single coordinator.** Concurrent same-type invocations share one MCP session and one browser context — their tabs clobber each other (see [docs/claude-code-mcp-dedup.md](docs/claude-code-mcp-dedup.md)). Subagents cannot see which types their siblings picked, so a parent that spreads browser work across multiple orchestrator subagents must assign each a disjoint slice of the numbers in its prompt.

## How it works

**Port 9377, not CDP's default 9222.** The daemon never contends with a legitimate 9222 user (IDE debuggers, a Chrome launched with `--remote-debugging-port`), and an agent spawning while the daemon is down finds the port closed instead of silently attaching to whatever debug browser happens to be listening — the attaching MCP client does no ownership check. Accepted risk: the CDP port is unauthenticated, so any local process can drive the shared browser. Fine on a single-user machine.

**Ownership is derived from the port, not a pidfile.** The listener on 9377 whose command line names this repo's profile dir is ours. That makes `start` safe under concurrent invocation — the race loser's Chromium dies on the profile lock and reports the winner's daemon — lets `stop` find orphaned daemons, and makes any *foreign* process on 9377 a hard error on every verb. `start` refuses to share it, since agents must never attach to a visible browser, and `stop` refuses to kill it.

**Per-session idle reaping.** The launchers run the pinned MCP under `mcp-session.js`. The lease begins when the client completes the initialization handshake with `notifications/initialized`, so a slow or failed startup is never reaped. Each MCP request, response, or notification renews the five-minute lease, and an in-flight request suspends it. On expiry the supervisor closes the MCP's stdin, then terminates that exact child if graceful shutdown stalls. Closing the MCP drops its CDP connection and isolated context without touching sibling sessions. The supervisor does not inject a warning into the MCP protocol; the agent definitions carry the relaunch instruction, and the closed transport makes later browser calls fail. Known gap: a request that never completes suspends its session's lease indefinitely.

**Daemon idle auto-stop.** `start` also spawns a watchdog that counts established connections to the CDP port every 30s and kills the browser after 5 minutes at zero. An MCP instance holds its CDP connection for exactly the lifetime of its process, so zero clients means nothing is attached. Connections are the signal rather than contexts or pages because an agent between tabs has neither, and a pageless context created by another CDP connection is invisible to Playwright's `contexts()`. Session reaping feeds this: even a wedged agent's connection drops five minutes after its last activity, so an abandoned fan-out always winds down to a stopped browser; `status` shows the attached-client count.

Because the daemon is machine-wide, an orchestrator should not run `stop` after a fan-out — another session's agents may still be attached, and shutdown is the watchdog's job.

**Crash-aware auto-start.** Agents attach through `browser-swarm-mcp.sh`, which starts the daemon whenever it finds it down, so a fan-out never needs a manual `start`. A **crash** still surfaces instead of being papered over: attached MCP calls fail loudly with a clean error within milliseconds when the browser dies, and the first agent to attach afterwards restarts the browser but gets a deliberately failed MCP — it comes up without browser tools and reports the crash to the orchestrator, which just relaunches it. The restart clears the crash state, so the relaunch and every later agent attach normally. Sacrificing that one agent launch guarantees the crash reaches a report even when it happened with nobody attached — the silent case a plain auto-restart would swallow. The browser and watchdog are spawned into their own sessions, so a harness cleaning up the sacrificed launcher's process tree cannot take the restarted daemon down with it. Crash detection is a shutdown marker beside the profile — written `running` on start, `clean` by the watchdog and `stop`, and scoped to the current boot so a reboot never reads as a crash; ownership stays derived from the port. Contexts clean themselves up: Chromium disposes a CDP-created context when its owning connection drops, so killed agents leave nothing behind. `status` showing `contexts: 1` — the untouched default new-tab page — means no leaks.

**Fingerprint.** The daemon generates a random seed on first start and persists it beside the profile, so the browser keeps one stable device identity across restarts. The seed is process-level, so isolated contexts do **not** get isolated fingerprints: every context on one daemon returns identical canvas hashes, WebGL strings, and screen metrics, and all attached agents look like one device. Run separate daemons where that matters. It launches under `taskpolicy -c utility`, so every Chromium process is QoS-clamped below the user's foreground apps.

## Docs

- [Bot detection and browser engines](docs/bot-detection.md) — which engines render against which detection vendors, how to identify the system a site is running, and why the default is fingerprint-chromium.
- [Claude Code inline MCP server dedup](docs/claude-code-mcp-dedup.md) — why concurrent subagents with identical MCP configs share one browser, and the workaround.

## License

MIT
