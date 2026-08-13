# BrowserSwarm

BrowserSwarm gives concurrent agents isolated browser contexts on two shared headless browser processes: fingerprint-Chromium by default and Firefox as a fallback for sites that block Chromium. A fan-out pays for contexts instead of full browser processes.

The standard pinned [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) provides the tools and wire protocol. A transparent TypeScript stdio supervisor gives each MCP session a five-minute inactivity lease. The TypeScript daemon runtime owns browser startup, crash reporting, idle shutdown, and safe port ownership.

macOS on Apple silicon only. The embedded Node.js must support direct erasable-syntax TypeScript execution (Node 26 at install time).

## Install

```sh
npx browser-swarm
```

The installer clones the repo to `~/.browser-swarm`, runs `npm ci`, installs both pinned browsers, and generates Claude Code and Codex agent definitions. From a checkout, run the pieces directly:

```sh
npm ci
./install-fingerprint-chromium.sh
./install-playwright-firefox.sh
./claude-agents/install-agents.sh
./codex-agents/install-agents.sh
```

The fingerprint-Chromium archive has a fixed SHA-256. The Playwright package checksum in `package-lock.json` pins its browser registry, and `install-playwright-firefox.sh` verifies the expected Playwright version, Firefox revision, and installed executable.

## Use

Agents start the required daemon automatically. Operators can inspect either backend:

```sh
./swarm start chromium
./swarm status chromium
./swarm stop chromium

./swarm start firefox
./swarm status firefox
./swarm stop firefox
```

Chromium MCP clients attach with `--cdp-endpoint http://localhost:9377 --isolated`. Firefox clients attach with `--endpoint ws://127.0.0.1:9378/browser-swarm --isolated`.

`--isolated` is mandatory. Without it, clients share a default context and fight over tabs.

Browser processes and loopback tests must run outside restrictive sandboxes. Run the fake-backed default suite with:

```sh
npm test
```

Run the real Firefox isolation gate after installing Firefox:

```sh
npm run test:firefox
```

## Agent definitions

[`claude-agents/`](claude-agents/) generates two definitions:

- `browser-swarm`: fingerprint-Chromium for normal browser work.
- `browser-swarm-firefox`: Firefox for sites confirmed to block Chromium.

Claude agents can run concurrently because the local [`mcp-per-subagent`](https://github.com/ahalekelly/claude-patching) patch gives each subagent its own MCP server process. `src/launch.ts` checks the patch canary before touching a daemon; an unpatched Claude Code session fails rather than sharing a browser session. [The bug record](docs/claude-code-mcp-dedup.md) explains why.

[`codex-agents/`](codex-agents/) generates one reusable `browser-swarm` definition. The canary only applies when `CLAUDECODE=1`, so Codex launches pass unchanged.

Both agent families splice their operating prompt from [agent-prompt.md](agent-prompt.md).

## Operating rules

**Keep fan-outs to about 10 concurrent browser agents.** Each isolated context uses roughly 100–200 MB under the 2-tab cap. This is a resource guideline, not a type-allocation rule.

**Keep at most 2 tabs open per context.** Close each tab as soon as its content is extracted. A 14-tab session reached about 6 GB RSS and froze the machine.

**Reach for a browser last.** Prefer a purpose-built API, then web search. Use a browser for forms, configurators, authenticated flows, and sites that starve cheaper paths.

**Relaunch after an idle disconnect.** An initialized MCP session closes after five minutes without activity. An in-flight request suspends its lease. A fresh agent gets a fresh isolated context.

**Do not stop a daemon after a fan-out.** Another session may still use it, so `stop` refuses while clients are attached (`--force` overrides). Its supervisor stops it after ten consecutive 30-second polls with no clients.

## How it works

**One lifecycle, two backends.** One detached `serve` supervisor per backend owns crash state and idle shutdown. Chromium's supervisor runs bare fingerprint-Chromium on CDP port 9377 under `taskpolicy -c utility`. Firefox's supervisor runs Playwright's managed build through plain `firefox.launchServer()` at `ws://127.0.0.1:9378/browser-swarm`. Plain `launchServer` is load-bearing: shared-browser mode disables per-client context isolation.

**Port-derived ownership.** The listener is ours only when it holds files open inside the install dir — its binary, its profile, or its lock — so a running browser stays recognizable across upgrades that move those files. Concurrent starts converge on one daemon. A foreign listener is a hard error, and `stop` refuses to kill it. Port 9377 avoids CDP's common 9222 default. The check reads `lsof`'s file tables rather than the process's command line because agent sandboxes commonly block `ps` while allowing `lsof`; without that, a sandboxed shell would misread our own daemon as foreign. Verbs that must write beside the daemon — a cold `start`, `stop` — still need an unsandboxed shell and say so when the sandbox denies the write; the blind-fire `start` against an already-running daemon works from anywhere.

**Patient cold starts.** A first-run browser profile on a loaded machine takes tens of seconds to reach its port, so the supervisor gives it 45 seconds. A launcher waits 25 — inside its MCP client's connection timeout — then reports that the browser is still booting and that relaunching the agent will attach to it. Giving up never kills the browser, so the wait is paid once rather than by every launch.

**Crash-aware auto-start.** Boot-scoped `chromium-daemon-state` and `firefox-daemon-state` markers say `running` while a daemon is live and `clean` after deliberate shutdown. The first attachment after an unclean death restarts the daemon and exposes the failure through a `browser_swarm_error` MCP tool; relaunching attaches normally. All startup failures use this tool, and detached supervisors survive cleanup of the sacrificed launcher.

**Idle cleanup.** `src/launch.ts` begins its lease after the MCP initialize handshake, renews it on protocol activity, and suspends it during requests. Expiry closes that MCP and its isolated context. Each `serve` supervisor counts established clients and stops its browser after five idle minutes.

**Stable Chromium fingerprint.** One random fingerprint seed persists across Chromium restarts. All contexts on the daemon present the same device identity. Firefox has no fingerprint modifications; it is the fallback engine.

## Docs

- [Bot detection and browser engines](docs/bot-detection.md)
- [Claude Code inline MCP server sharing](docs/claude-code-mcp-dedup.md)

## License

MIT
