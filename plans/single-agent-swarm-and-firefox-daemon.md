# Stage 2 — single-agent swarm, Firefox shared daemon, TS runtime

## Goal

Stage 1 (claude-patching `mcp-per-subagent.mjs`) gives every Claude Code subagent its own MCP server process and stamps `CLAUDE_MCP_PER_AGENT=1` into each stdio server's environment. That makes the ten-sibling workaround and all its collision machinery obsolete. Stage 2 collapses the swarm to one agent definition guarded by a canary check, gives Firefox the same shared-daemon economics as Chromium, and ports the bash daemon runtime to TypeScript so both daemons share one lifecycle implementation.

## Current state (verified 2026-08-07)

- Stage 1 is promoted and live: `~/.local/bin/claude` → 2.1.224 patched; `mcp-per-subagent` is mandatory in the promotion gate, so a promoted binary always carries it. On stock binaries the canary is absent — that is the detectable failure mode.
- Ten generated Claude defs (`browser-swarm-1…10`), each declaring server `playwrightN` → `browser-swarm-mcp.sh <node> <N>`. One hand-copied launched-mode Firefox def (its repo copy has a placeholder `/path/to/` command). One reusable Codex def (tag `codex`).
- `shared-browser.sh` (247-line bash): port-derived ownership, crash marker, idle watchdog, `spawn_detached`, `ensure`. `mcp-session.js` (CJS): per-session five-minute idle supervisor.
- The pinned `@playwright/mcp` 0.0.78 supports `--endpoint <endpoint>` ("bound browser endpoint to connect to") — verified in its CLI help.
- Firefox gating experiment (run 2026-08-06 during stage-1 planning): `firefox.launchServer()` on the pinned Playwright + two `--endpoint` MCP clients → fully isolated contexts on **one** Firefox process; killing one client reclaims its context without touching the other; late-join works. The reported ws endpoint is IPv6 loopback — use it verbatim, never rewrite the host. **Trap:** `launchServerShared`/`_sharedBrowser: true` *disables* context isolation; plain `launchServer` is correct.
- The embedded node (`command -v node` at install time) is v26: it executes erasable-syntax TypeScript directly, no build step, no new dependency.

## Part A — TypeScript runtime (behavior-identical port)

Replace `shared-browser.sh` + `mcp-session.js` with TS sources run by the embedded node:

- `src/daemon.ts` — the lifecycle logic, parameterized by a backend: port-derived ownership (listener whose command line names the backend's profile/marker), crash marker scoped to boot epoch, idle watchdog (established connections on the port, 10 × 30 s), detached spawning, and the `start`/`stop`/`status`/`ensure` verbs with today's exact semantics — including `ensure`'s sacrificed-agent crash reporting.
- Two backends: **chromium-cdp** (fingerprint-chromium, `--remote-debugging-port=9377`, fingerprint seed, taskpolicy clamp) and **firefox-ws** (Part B).
- `src/mcp-session.ts` — the idle supervisor, ported as-is.
- `src/launch.ts <chromium|firefox>` — the MCP entry point the agent defs invoke: canary check (Part C), backend `ensure`, then exec the pinned MCP under the supervisor with a per-invocation output dir. `browser-swarm-mcp.sh` and `firefox-mcp.sh` are deleted; the Codex def moves onto the same entry point (the canary check keys on `CLAUDECODE=1`, so Codex spawns pass through untouched).
- `shared-browser.sh` becomes a thin operator alias or is deleted in favor of `./swarm <verb> [browser]` — pick one name and update README. Everything keeps failing loudly; no compatibility shims for the old script names.
- The four test files keep their fake-browser fixtures and assert the same behavior against the TS runtime. This part lands with zero behavior change — the tests passing unmodified (bar invocation paths) is the definition of done.

## Part B — Firefox shared daemon

One long-lived headless Firefox via Playwright `launchServer`, replacing the full-browser-per-invocation launched mode:

- Backend: `firefox.launchServer({ port: 9378, wsPath: <fixed> })` using the repo's pinned playwright-core and its managed Firefox build (add the browser install to `install.sh` / `install-fingerprint-chromium.sh`'s sibling step, checksum story per Playwright's registry). The daemon writes the *reported* `wsEndpoint` verbatim to a state file beside the profile; `launch.ts` reads it and fails loudly if missing or the port is closed.
- Clients attach with `--endpoint <ws> --isolated`. Same watchdog, crash-marker, and ownership rules as Chromium, from the shared `daemon.ts` — this reuse is why Part A precedes it.
- Isolation gate: a test reproducing experiment B against the real implementation — two MCP sessions on one Firefox process, each sees only its own pages, killing one reclaims its context. Real-Firefox tests are opt-in (`npm run test:firefox`); the default suite keeps using fakes.
- The Firefox def becomes template-generated (fixing the hand-copied placeholder-path wart) and its description flips from "costs a full browser process per invocation" to cheap contexts on one process — still "use plain browser-swarm unless the site blocks Chromium". No fingerprinting for Firefox; it is the fallback engine, not the stealth one.

## Part C — single-agent cutover + canary check

- One Claude def `browser-swarm`, server name `playwright`, generated from the template; `SWARM_SIZE` and the `__N__` machinery die. The installer also **deletes stale `browser-swarm-*.md`** from `~/.claude/agents/` so old numbered defs can't linger beside the new one.
- Canary check in `launch.ts`: if `CLAUDECODE=1` and `CLAUDE_MCP_PER_AGENT` is unset, exit nonzero before touching the daemon, with an error stating the session is on an unpatched Claude Code where same-named inline servers share one browser session, pointing at claude-patching and issue #84638. An unpatched machine gets a loud refusal, never a silent shared browser.
- Prose rewrite, all in one commit with the cutover:
  - `agent-prompt.md`: drop the collision-forensics paragraph (foreign-tab attribution, output-dir number reading, pid-migration signal) — under the patch each invocation owns its server process, and the canary check refuses the unpatched case. Keep worker-not-orchestrator, read-only, filesystem and tab hygiene, crash and idle-reap reporting. A residual one-liner: tabs you didn't open are a bug — stop and report.
  - `README.md`: Agent definitions and Operating rules sections; the concurrency rule changes from type-roster allocation to a resource guideline (each context is ~100–200 MB with the 2-tab cap; keep fan-outs to ~10 concurrent agents).
  - `docs/claude-code-mcp-dedup.md`: stays as the record of the upstream bug; add that the local patch removes the sharing per-subagent and the shipped defs now require it (the canary check enforces this).
  - `~/.agents/AGENTS.md` workflow bullet (`browser-swarm-1…10`, "one per type") → single type, concurrency guideline. The only cross-repo reference found by grep.
- Accepted from stage 1: sequential relaunches lose warm-server reuse — attaching to the shared daemon is cheap.

## Validation

1. Suite green: ported tests, canary-check test (with/without `CLAUDECODE`/canary), Firefox lifecycle on fakes; `npm run test:firefox` isolation gate.
2. Manual fan-out on the patched binary: three concurrent invocations of the single `browser-swarm` def on distinct sites → three distinct server processes and output dirs, no cross-visibility; two Firefox agents → one Firefox process, isolated contexts.
3. Negative control: run one invocation with `CLAUDE_MCP_PER_AGENT` stripped from the env → the loud canary refusal, no daemon start.

## Sequencing

Separate commits: (1) TS runtime port, tests green, zero behavior change; (2) Firefox daemon + tests + def; (3) cutover + canary + repo prose; (4) AGENTS.md and manual end-to-end.

## Out of scope

- Retiring the patch: when upstream #84638 is fixed, the canary check (not the swarm) is what retires — noted here so the check's removal is a one-liner, not an archaeology dig.
- Firefox fingerprinting, non-macOS support, and any change to the npx install flow beyond the installer edits above.
