# browser-leaf

One long-lived headless browser, shared by every agent in a fan-out.

Give a coding agent a Playwright MCP server and each subagent launches its own browser. Ten parallel subagents is ten browsers, and on a laptop that is several gigabytes of renderer processes and a frozen machine. This repo replaces that with a single [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) daemon on a fixed CDP port; each agent attaches as its own isolated browser context, with its own cookies, storage, and tabs.

The MCP server is the standard pinned [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) — nothing here replaces or wraps it. What this repo adds is the daemon that makes sharing one browser safe, plus the agent definitions and operating rules that keep a fan-out from eating the machine.

macOS on Apple silicon only. The daemon uses `taskpolicy`, `lsof`, and a pinned macOS arm64 browser build.

## Install

```sh
git clone https://github.com/ahalekelly/browser-leaf.git
cd browser-leaf
npm ci                              # pinned @playwright/mcp
./install-fingerprint-chromium.sh   # one-time browser install, checksum-verified
```

## Use

```sh
./shared-browser.sh start   # idempotent — exit 0 if our daemon is already up, safe to fire blind
./shared-browser.sh status  # pid + watchdog + attached clients + open pages
./shared-browser.sh stop    # rarely needed; the watchdog stops idle daemons
```

Point any Playwright MCP instance at it:

```
--cdp-endpoint http://localhost:9377 --isolated
```

`--isolated` is mandatory, and it composes with `--cdp-endpoint` rather than replacing it. With `--cdp-endpoint` alone every attached instance lands in the browser's default context and they hijack each other's tabs; adding `--isolated` gives each instance its own context.

Both scripts must run outside any sandbox — Chromium can't write its crashpad and profile files inside one, and a sandbox with no network can't fetch the browser.

## Agent definitions

[`examples/claude-code/`](examples/claude-code/) holds ready-to-use Claude Code subagent definitions: five sibling `browser-leaf` types that attach to the daemon, and a launched-mode Firefox variant for sites where Chromium is blocked. Copy them to `~/.claude/agents/` and set the paths.

They must be five near-identical files rather than one, because Claude Code deduplicates inline MCP server configs by content across concurrent subagents — see [docs/claude-code-mcp-dedup.md](docs/claude-code-mcp-dedup.md). Each sibling's config differs only in its `--output-dir`, which is what defeats the dedup. "Cleaning up" those paths to match silently reintroduces one shared browser for every leaf.

The system prompt in those files carries the operating rules that matter in practice: headless only, read-only unless the task explicitly authorizes otherwise, writes confined to a temp output dir, and the tab cap below.

## Operating rules

**At most 2 open tabs per context, closed as soon as their content is extracted.** Every open tab holds a renderer process and hundreds of megabytes; a 14-tab session reached ~6 GB RSS and froze the machine. This is the single most important rule for anything that attaches.

**Reach for a browser last.** A purpose-built MCP or API first, then web search, which on most sites returns page text and so covers plain reading. A browser is the right tool for interaction — forms, carts, configurators, authenticated flows — and for sites that starve the cheaper paths, where search sees only a page title and a plain fetch gets a body-less shell. It costs far more tokens and wall-clock than either, and it is the only path a bot wall can block.

## How it works

**Port 9377, not CDP's default 9222.** The daemon never contends with a legitimate 9222 user (IDE debuggers, a Chrome launched with `--remote-debugging-port`), and an agent spawning while the daemon is down finds the port closed instead of silently attaching to whatever debug browser happens to be listening — the attaching MCP client does no ownership check. Accepted risk: the CDP port is unauthenticated, so any local process can drive the shared browser. Fine on a single-user machine.

**Ownership is derived from the port, not a pidfile.** The listener on 9377 whose command line names this repo's profile dir is ours. That makes `start` safe under concurrent invocation — the race loser's Chromium dies on the profile lock and reports the winner's daemon — lets `stop` find orphaned daemons, and makes any *foreign* process on 9377 a hard error on every verb. `start` refuses to share it, since agents must never attach to a visible browser, and `stop` refuses to kill it.

**Idle auto-stop.** `start` also spawns a watchdog that counts established connections to the CDP port every 30s and kills the browser after 5 minutes at zero. An MCP instance holds its CDP connection for exactly the lifetime of its process, so zero clients means nothing is attached. Connections are the signal rather than contexts or pages because an agent between tabs has neither, and a pageless context created by another CDP connection is invisible to Playwright's `contexts()`. Known gap: a wedged agent whose MCP process never exits keeps its connection and defers auto-stop indefinitely; `status` shows the attached-client count.

Because the daemon is machine-wide, an orchestrator should not run `stop` after a fan-out — another session's agents may still be attached, and shutdown is the watchdog's job.

**No auto-restart, by design.** If the browser crashes, every attached MCP call fails loudly with a clean error within milliseconds rather than hanging, and the operator starts it again. Contexts clean themselves up: Chromium disposes a CDP-created context when its owning connection drops, so killed agents leave nothing behind. `status` showing `contexts: 1` — the untouched default new-tab page — means no leaks.

**Fingerprint.** The daemon generates a random seed on first start and persists it beside the profile, so the browser keeps one stable device identity across restarts. The seed is process-level, so isolated contexts do **not** get isolated fingerprints: every context on one daemon returns identical canvas hashes, WebGL strings, and screen metrics, and all attached agents look like one device. Run separate daemons where that matters. It launches under `taskpolicy -c utility`, so every Chromium process is QoS-clamped below the user's foreground apps.

## Docs

- [Bot detection and browser engines](docs/bot-detection.md) — which engines render against which detection vendors, how to identify the system a site is running, and why the default is fingerprint-chromium.
- [Claude Code inline MCP server dedup](docs/claude-code-mcp-dedup.md) — why concurrent subagents with identical MCP configs share one browser, and the workaround.

## License

MIT
