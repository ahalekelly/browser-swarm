# BrowserSwarm Linux port — handoff, 2026-08-31 01:10 PDT

State of the Linux x86_64 port of BrowserSwarm on akelly-desktop, what has been tested, and what is left. Shipped in **0.2.0**; the daemon, both backends, and the Claude and Codex agent definitions are installed and working on this machine.

## What shipped

Commits on `main` (all pushed to `github.com/ahalekelly/browser-swarm`):

| Commit | Change |
|---|---|
| `8bd5034` | Linux x86_64 daemon support: platform table (binary path, `nice -n 10` vs `taskpolicy`, boot ID from `/proc/sys/kernel/random/boot_id`), Linux tarball in the installer with its own pinned SHA-256, per-platform test fixtures, `tests/fingerprint-compare.mjs`, docs |
| `34fe382` | AppArmor profile install for hosts that restrict unprivileged user namespaces |
| `4bc47b7` | Software WebGL renderers (`SwiftShader`, `llvmpipe`, `Mesa`) count as consistency leaks for every config |
| `71ce715` | Installer's AppArmor guard returns 0 so `set -e` does not abort on unrestricted hosts |
| `98bbb19` | Score a comparison trial from the settled page, not the first response |
| `069718e` | AppArmor profile also attaches to worktree copies of the binary |
| `40522b6` | Built-in Cloudflare, Akamai, and DataDome comparison targets |
| `84219ce` | Comparison example in `docs/bot-detection.md` uses the protected targets |
| `b31e78f` | Preliminary comparison report |

`7ae34e4` (Release 0.2.0) and `8b5b09f` (@playwright/mcp 0.0.79) came from a separate session and sit between `84219ce` and `b31e78f`.

`~/.agents` tracks the submodule at `7ae34e4`; the pointer needs a bump to pick up `b31e78f`. Another session was committing in `~/.agents` at 00:52 today, so that bump is left undone rather than risk colliding with it.

## Test status

| Test | Command | Result |
|---|---|---|
| Unit suite (fake browsers) | `npm test` | **29/29 pass** at 0.2.0 |
| Real Firefox isolation gate | `npm run test:firefox` | **1/1 pass** at 0.2.0 |
| Crash recovery across a killed launcher process group | in `npm test` | **pass**, 3 consecutive runs after the ownership-race fix |
| Chromium installer + version | `./install-fingerprint-chromium.sh` | **pass**, Chromium 148.0.7778.215 |
| Firefox installer | `./install-playwright-firefox.sh` | **pass**, revision 1534 |
| Chromium daemon lifecycle | `./swarm start/status/stop chromium` | **pass** |
| Firefox daemon lifecycle | `./swarm start/status/stop firefox` | **pass** |
| MCP client attach through `src/launch.ts` | stdio JSON-RPC probe | **pass**, navigated and snapshotted |
| **Chromium multi-agent isolation, 5 agents** | 5 parallel `browser-swarm` subagents | **pass** — each saw only its own 2 tabs and its own `localStorage` marker through a 20 s overlap; 5 distinct MCP server pids; `swarm status` showed one Chromium with 5 attached clients; clean drain to 0 |
| **Firefox multi-agent isolation, 3 agents** | 3 parallel `browser-swarm-firefox` subagents | **pass** — same, on one shared Firefox process (pid confirmed via `swarm status`) |
| Post-0.2.0 agent smoke, 2 agents | 2 parallel `browser-swarm` subagents | **pass**, both attached concurrently to one daemon |
| Fingerprint comparison, preliminary | `tests/fingerprint-compare.mjs` | **done** — see `2026-08-29-fingerprint-platform-preliminary.md` |
| Home Depot recheck after 26 h | `--configs macos --targets akamai-homedepot` | **done** — still 403 3/3; headless Firefox gets 200 |
| macOS regression | `npm test` on the Mac | **blocked** — `adrians-macbook-air` offline on Tailscale since 2026-08-29, last seen 1d ago |
| Codex fan-out | 5 `browser-swarm` agents from Codex | **not run** |
| Full multi-day comparison | see below | **not run** |

`tests/protocol.test.js` timed out twice under parallel load (once inside Pi's sandbox, once in a worktree) and passes standalone and in every full-suite run since. Treat a lone protocol timeout as load flakiness, not a regression.

## Bugs found and fixed during the port

- **Ownership race in `daemon.ts`.** `ownerPid()` and `hasListener()` were two separate `lsof` passes; a browser that started listening between them was reported as a foreign process. Only surfaced on Linux timing. The supervisor refactor on `main` resolves ownership only after `ready()`, so the fix landed there instead.
- **`--disable-crashpad-for-testing` breaks Chromium on Linux** — child processes die with "Crashing due to FD ownership violation". Reverted. The `chrome_crashpad_handler: --database is required` line in the log is harmless noise; leave it.
- **`set -e` + `|| return`** in the installer's AppArmor guard aborted the install on hosts without the userns restriction.
- **Comparison scorer read the first response.** A Cloudflare managed challenge answers 403 "Just a moment..." and then swaps in the real page, so a config that passed scored identical to one that failed; its `challenge-url` regex also matched the word "challenge" in the target URL itself. Now scored after an 8 s settle from the last main-frame navigation response, with a `challenge-title` marker.
- **Leak rule exempted the `linux` config** and never matched `SwiftShader`.

## Environment facts worth keeping

- **AppArmor.** Ubuntu 26.04 sets `apparmor_restrict_unprivileged_userns=1`, which kills Chromium with "No usable sandbox!". The installer writes `/etc/apparmor.d/browser-swarm-chromium` (attachment glob covers `.agents/worktrees/*/`) and needs `sudo` once. Never work around this with `--no-sandbox` — this browser visits untrusted sites.
- **Truly headless.** No display server, `DISPLAY` unset, both backends launch with headless flags. Xvfb is installed but X11/GNOME do not start at boot.
- **Pi's sandbox cannot run browsers** (read-only HOME, blocked unix sockets). Any live-browser step in a Pi session has to be handed back to the orchestrator and run with `dangerouslyDisableSandbox: true`.
- **Agent definitions load at session start.** A session that predates `claude-agents/install-agents.sh` cannot spawn `browser-swarm`; use a fresh session or `claude -p`.

## Comparison findings so far

Full detail in `2026-08-29-fingerprint-platform-preliminary.md`. Short version:

- `--fingerprint-platform=linux` is **out**: it passes the host's real SwiftShader software renderer through, the same signature as stock headless. `macos` and `windows` get coherent spoofed GPUs (Apple M4, Intel Iris Xe).
- `macos` and `windows` are **indistinguishable** on everything measured. Production stays on `macos`, which also keeps the Mac and Linux hosts identical.
- fingerprint-chromium beats stock headless decisively on Cloudflare's managed challenge (6/6 vs 0/6) and on DataDome first contact.
- **leboncoin (DataDome alone) is the one target with a real escalation curve**: renders 3 times, then sticky 403, despite a fresh context per trial — DataDome is scoring the IP + fingerprint pair over time. This is the behaviour the full run exists to measure.
- Home Depot (Akamai) hard-blocks headless fingerprint-Chromium regardless of platform value and regardless of cooldown, while headless Firefox passes the edge check. It measures the engine, not the platform.

## Open items

1. **macOS regression.** When `adrians-macbook-air` is back on Tailscale: pull `main`, `npm ci && npm test`, `./install-fingerprint-chromium.sh` (expect "already installed"), `./swarm start/status/stop chromium`. Nothing in the port should affect macOS, but the platform table and the test fixtures were both touched.
2. **Bump the `~/.agents` submodule pointer** to `b31e78f` once the other session working there is done.
3. **Full comparison run.** `macos` vs `windows`, 20 trials per target, cooldown between config blocks sized by how long leboncoin takes to render again for `macos`, order reversed on day 2. Targets: `cloudflare-challenge`, `datadome-leboncoin`, `datadome-stacked-hermes`, plus a PerimeterX site; keep `akamai-homedepot` as an engine canary. Write `--jsonl` to a durable path — the preliminary run's raw data was lost to a /tmp clean.
4. **If `macos` and `windows` stay tied**, try a headed-under-Xvfb `macos` variant through the same protocol before calling it. Xvfb gives real window/screen/focus properties; it does not change the GPU story.
5. **Codex fan-out** (`codex-agents/browser-swarm.toml`) has never been exercised on Linux.
