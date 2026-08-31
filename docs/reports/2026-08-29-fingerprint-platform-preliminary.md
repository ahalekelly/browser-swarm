# Fingerprint platform comparison, preliminary run — 2026-08-29

Question: on the Linux host (akelly-desktop, Ubuntu 26.04, x86_64, headless, no display server), which `--fingerprint-platform` value for fingerprint-chromium 148.0.7778.215 draws the fewest challenges? Configs: `stock` (Playwright's chromium_headless_shell, no fingerprint flags, sanity control), `linux`, `macos`, `windows`. Same seed for all fingerprint configs. Method: the comparison section of `docs/bot-detection.md`.

## Phase 1 — consistency probes (1 visit per config per site)

creepjs, browserleaks JavaScript + WebGL, bot.sannysoft.com, rebrowser bot-detector all rendered for every config. UA, `navigator.platform`, `sec-ch-ua-platform`, and client hints agree within each config. WebGL renderer:

| Config | WebGL renderer | Leak |
|---|---|---|
| stock | ANGLE SwiftShader (software) | software GL |
| linux | ANGLE SwiftShader (software) | software GL |
| macos | ANGLE Metal, Apple M4 | none |
| windows | ANGLE D3D11, Intel Iris Xe | none |

With `--fingerprint-platform=linux`, fingerprint-chromium passes the host's real software renderer through; `macos` and `windows` get a spoofed GPU coherent with the claimed OS.

## Phase 2 — escalation quick-look (6 trials per site per config, 10 s apart, fresh context each; config blocks stock → macos → linux → windows with 10 min cooldowns)

Scored by the settled page title, because the script's own scorer had two bugs (it used the first response's status, which is the interstitial's 403 even when the challenge later passes, and its `challenge-url` regex matched the word "challenge" in the target URL). Fix in progress in `tests/fingerprint-compare.mjs`.

| Site | Detection | stock | linux | macos | windows |
|---|---|---:|---:|---:|---:|
| scrapingcourse.com/cloudflare-challenge | Cloudflare managed challenge | 0/6 | 6/6 | 6/6 | 6/6 |
| homedepot.com product page | Akamai Bot Manager (403 "Error Page") | 0/6 | 0/6 | 0/6 | 0/6 |
| amazon.com product page | — | 6/6 | 6/6 | 6/6 | 6/6 |
| google.com search | — | 6/6 | 6/6 | 6/6 | 6/6 |

No escalation within any 6-trial block: every site was either always rendered or always blocked from trial 1.

## Reading

- fingerprint-chromium beats stock headless decisively on Cloudflare's managed challenge (6/6 vs 0/6) and the platform value made no difference there.
- Amazon and Google product/search pages did not challenge even stock headless at this request rate, so they carry no signal for this question.
- Home Depot blocked every config, including `macos`, from trial 1. The recheck below shows this is Akamai rejecting headless fingerprint-Chromium as an engine, not IP reputation.
- `linux` is out on the consistency probe alone: it reports a software renderer, the same signature as stock headless, and Linux desktops are rare enough to be a signal on their own.
- Between `macos` and `windows` this run cannot separate them; the plan's tie rule picks `macos`, which also keeps the Mac and Linux hosts identical. Production stays on `--fingerprint-platform=macos`.

## What the full run needs

- Sites that actually discriminate: the Cloudflare managed challenge and leboncoin (the only target with a real escalation curve). Drop Amazon and Google. Home Depot stays as an engine canary, not a platform target. Add a PerimeterX site and a second DataDome-alone site.
- 20 trials per site, 1 h+ cooldowns, `macos → windows` on day 1 and reversed on day 2 (drop `linux` and `stock` after the day-1 control).
- If `macos` and `windows` are still tied on headless, add a headed-under-Xvfb `macos` variant (Xvfb is installed; no GPU, so the spoofed GPU string still carries the WebGL story).

## DataDome (added after the main run)

Sites confirmed by headers: leboncoin.fr (`datadome` cookie, 403 to a bare curl — DataDome alone) and hermes.com/us/en (`x-datadome: protected` behind Cloudflare — DataDome stacked). First contact, 1 trial each: `stock` got 403 from leboncoin and rendered Hermes; `macos` rendered both.

Escalation, `macos` only, 6 trials per site 10 s apart, fresh isolated context each trial:

| Site | Trials | First challenge | Sticky |
|---|---|---:|---|
| leboncoin (DataDome alone) | ✓ ✓ ✓ ✗ ✗ ✗ | 4 | yes |
| Hermes (DataDome + Cloudflare) | ✓ ✓ ✓ ✓ ✓ ✓ | — | — |

leboncoin flips to a sticky 403 after three renders even though every trial is a fresh context with no cookies, so DataDome is scoring the IP + fingerprint pair over time. This is the escalation the full comparison is designed to measure and the one site in this run with a first-challenge index; it belongs in the full run for every config, with the cooldown between config blocks sized by how long leboncoin takes to render again for `macos`.

## Home Depot recheck after cooldown (2026-08-31)

26 hours after the main run, with no traffic to the site in between:

| Engine | Result |
|---|---|
| fingerprint-Chromium, `macos` | 403 "Error Page", Akamai markers, 3/3 trials |
| Playwright Firefox, headless | 200, no interstitial; site shell rendered (header, cart, store "San Jose"), product detail never populated within 10 s |

The block is not IP reputation carried over from the `stock` block: it survives a full day of quiet and hits trial 1 every time. Akamai on this site rejects headless fingerprint-Chromium outright while letting headless Firefox through the edge check, matching the engine table in `docs/bot-detection.md`. Home Depot therefore measures the engine, not the platform value, so it cannot discriminate between `macos` and `windows`; keep it in the suite as an engine canary rather than as a platform target.

## Data

Raw per-trial JSONL lived under `/tmp/claude/fp-compare/` and was cleared when the machine cleaned /tmp. The tables above are the surviving record; rerun with `--jsonl` under a durable path next time.
