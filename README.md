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

Chromium MCP clients attach with `--cdp-endpoint http://localhost:9377 --isolated`. Firefox clients attach with `--endpoint <reported-ws-endpoint> --isolated`; `src/launch.ts` reads the endpoint that `firefox.launchServer()` wrote to `firefox-ws-endpoint` and uses it verbatim, including its IPv6 loopback host.

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

The installer deletes stale numbered `browser-swarm-*.md` definitions. One Claude definition can run concurrently because the local [`mcp-per-subagent`](https://github.com/ahalekelly/claude-patching) patch gives every subagent its own MCP server process. `src/launch.ts` checks the patch canary before touching a daemon; an unpatched Claude Code session fails loudly rather than sharing one browser session. [The bug record](docs/claude-code-mcp-dedup.md) explains why.

[`codex-agents/`](codex-agents/) generates one reusable `browser-swarm` definition. The canary only applies when `CLAUDECODE=1`, so Codex launches pass unchanged.

Both agent families splice their operating prompt from [agent-prompt.md](agent-prompt.md).

## Operating rules

**Keep fan-outs to about 10 concurrent browser agents.** Each isolated context uses roughly 100–200 MB under the 2-tab cap. This is a resource guideline, not a type-allocation rule.

**Keep at most 2 tabs open per context.** Close each tab as soon as its content is extracted. A 14-tab session reached about 6 GB RSS and froze the machine.

**Reach for a browser last.** Prefer a purpose-built API, then web search. Use a browser for forms, configurators, authenticated flows, and sites that starve cheaper paths.

**Relaunch after an idle disconnect.** An initialized MCP session closes after five minutes without activity. An in-flight request suspends its lease. A fresh agent gets a fresh isolated context.

**Do not stop a daemon after a fan-out.** Another session may still use it. The watchdog stops it after ten consecutive 30-second polls with no attached clients.

## How it works

**One lifecycle, two backends.** `src/daemon.ts` parameterizes ownership, crash state, watchdogs, and detached spawning. Chromium runs fingerprint-Chromium on CDP port 9377 under `taskpolicy -c utility`. Firefox runs Playwright's managed build through plain `firefox.launchServer()` on port 9378 with a fixed WebSocket path. Plain `launchServer` is load-bearing: shared-browser mode disables per-client context isolation.

**Port-derived ownership.** The listener is ours only when its command line names the backend's profile or ownership marker. Concurrent starts converge on one daemon. A foreign listener is a hard error, and `stop` refuses to kill it. Port 9377 avoids CDP's common 9222 default.

**Crash-aware auto-start.** A boot-scoped state marker says `running` while a daemon is live and `clean` after deliberate shutdown. The first attachment after an unclean death restarts the daemon but deliberately fails that agent's MCP initialization, ensuring the crash gets reported. Relaunching attaches normally. Browsers and watchdogs run in detached sessions, so cleanup of the sacrificed launcher cannot kill the recovered daemon.

**Idle cleanup.** `src/mcp-session.ts` begins its lease after the MCP initialize handshake, renews it on protocol activity, and suspends it during requests. Expiry closes that MCP and its isolated context. The daemon watchdog counts established client connections and stops its browser after five idle minutes.

**Stable Chromium fingerprint.** One random fingerprint seed persists across Chromium restarts. All contexts on the daemon present the same device identity. Firefox has no fingerprint modifications; it is the fallback engine.

## Docs

- [Bot detection and browser engines](docs/bot-detection.md)
- [Claude Code inline MCP server sharing](docs/claude-code-mcp-dedup.md)

## License

MIT
