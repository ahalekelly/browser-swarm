# Chrome and Firefox, headed and headless — 2026-10-31 09:01 UTC

Source: `data/2026-10-31-chrome-firefox-headed.jsonl` (400 trials, run `2026-10-31T06:22:37.528Z-2125227`, 06:22–09:01 UTC on akelly-desktop). Reference: `data/2026-10-31-chrome-headed-xvfb.jsonl`, a **different, earlier run** (130 trials, 05:08–06:00 UTC) that included fingerprint-chromium.

## Question

Can Linux browser-swarm swap fingerprint-chromium (Chromium 150 on Linux, 148 on Mac) for a browser that stays current? Candidates: Google Chrome stable, which auto-updates through apt, and browser-swarm's own Playwright Firefox, each headed in Xvfb and headless.

## Setup

| Config | Browser | Display | Launch |
|---|---|---|---|
| `chrome-headed` | Google Chrome 156.0.8078.79 | Xvfb 1920×1080 | spawned by the script, attached over CDP |
| `chrome` | same | `--headless` | same |
| `firefox-headed` | Playwright Firefox 157.0 (revision 1555, Playwright 1.64.1) | Xvfb 1920×1080 | `firefox.launchServer`, like the controller's Firefox backend |
| `firefox` | same | headless | same |

Protocol: 5 protected targets × 20 trials × 4 configs, all four browsers open for the whole run. Each round visits every target once per config, rotating config order; 15 s between trials, 8 s settle, fresh context per trial. The IP was shared with live browser-swarm use, and earlier runs that night had already visited every target.

Exact Chrome command lines, read from `/proc` during the run (both wrapped in `nice -n 10`):

- `chrome-headed`: `/opt/google/chrome/chrome --window-size=1920,1080 --use-angle=vulkan --enable-features=Vulkan --remote-debugging-port=N --user-data-dir=<tmp> --no-first-run`
- `chrome`: the same with `--headless` instead of `--window-size`; Chrome itself appends `--noerrdialogs --ozone-platform=headless --ozone-override-screen-size=800,600`.

Playwright did not launch Chrome, so none of its launch defaults applied: no `--enable-automation`, `--disable-component-update`, or `--disable-background-networking`. CRLSet, Safe Browsing and component updates ran as in a normal Chrome. The production controller also spawns the browser itself, so these results carry over if production uses the same flags: the two Vulkan flags plus `--mute-audio`.

The Vulkan flags matter. Xvfb has no GPU, and without them headed Chrome has no WebGL at all; with them it reports the host's real GPU (`ANGLE (AMD, Vulkan 1.4.335 (AMD Radeon Graphics (RADV RENOIR)…), radv)`). Headed Firefox in Xvfb gets only software WebGL (Mesa llvmpipe); no environment variable or pref tried reached the GPU. Headless configs run without `DISPLAY`, because with a display set, headless Firefox gains GPU WebGL it lacks in production.

Playwright's bundled Chromium was not used: it reports the `Chromium` brand without `Google Chrome` in client hints, and it isn't the auto-updating browser production would run.

## Results

Rendered trials out of 20 (challenged or blocked otherwise; every failure was a 403, with a challenge title on Cloudflare and Akamai):

| Target | chrome-headed | chrome | firefox-headed | firefox |
|---|---:|---:|---:|---:|
| cloudflare-challenge | **15** | 0 | 0 | 0 |
| datadome-leboncoin | 0 | 0 | 3 | 1 |
| datadome-stacked-hermes | 20 | 20 | 20 | 20 |
| perimeterx-therealreal | **20** | 0 | **20** | 5 |
| akamai-homedepot | **20** | 0 | 0 | **20** |
| **Total of 100** | **75** | 20 | 43 | 46 |

Blocks were sticky (every trial from the first failure on failed) except `chrome-headed` on Cloudflare, Firefox on Leboncoin, and `firefox` on TheRealReal.

Headed is not uniformly easier. Headed Chrome beats headless Chrome on every contested target. Headed Firefox, in contrast, loses Akamai, which headless Firefox renders 20/20, and gains TheRealReal.

### Consistency leaks

| Config | Leaks |
|---|---|
| chrome-headed | none |
| chrome | UA contains `HeadlessChrome/156.0.0.0` |
| firefox-headed | `navigator.webdriver=true`; WebGL `Mesa llvmpipe` |
| firefox | `navigator.webdriver=true`; WebGL unavailable |

Playwright's Firefox exposes `navigator.webdriver=true` headed and headless, so the production Firefox backend carries that leak too.

### Reference: fingerprint-chromium, from a different run

These rounds come from the earlier run (05:08–06:00 UTC), stopped after 9 rounds when the comparison was redesigned. Production config: `--fingerprint-platform=macos`, headless, seed 42424242 rather than the production seed. They are **not directly comparable** to the tables above: different hour, different IP state, and a different set of configs sharing the IP. Chrome rows are included because they ran alongside fingerprint-chromium and show how the two runs differ.

| Target | macos (fingerprint-chromium) | chrome-headed | chrome |
|---|---:|---:|---:|
| cloudflare-challenge | 8/9 | 4/9 | 0/9 |
| datadome-leboncoin | 2/9 (4 page crashes) | 4/9 | 0/9 |
| datadome-stacked-hermes | 4/9 (5 page crashes) | 9/9 | 9/9 |
| perimeterx-therealreal | 7/8 (1 page crash) | 9/9 | 0/8 |
| akamai-homedepot | 0/8 | 8/8 | 0/8 |
| **Total** | 21/43 | 34/44 | 9/43 |

fingerprint-chromium showed no consistency leaks. **Its renderer crashed on 10 of 43 trials**, all on DataDome-protected Leboncoin and Hermès plus one on TheRealReal. A crash on the first Leboncoin visit also aborted an earlier attempt at this run; the script now scores crashes as failures. Neither Chrome config crashed. fingerprint-chromium was the only config to beat headed Chrome anywhere, on Cloudflare (8/9 vs 4/9). Headed Chrome's Leboncoin result fell from 4/9 in this run to 0/20 in the main run, consistent with DataDome escalating against the IP overnight.

## Does falling back after a block get flagged?

The fallback pattern is: one browser is blocked, then the same IP retries the same site with a different fingerprint seconds later. The rotation produces exactly that sequence, about 15 s apart.

**Design caveat.** The rotation fixes each config's predecessor within a round: `chrome` always follows `chrome-headed`, `firefox-headed` always follows `chrome`, `firefox` follows `firefox-headed`, and `chrome-headed` follows `firefox`. Pooled rates ("after a block" vs "after a render") therefore mostly encode which config came before, not a penalty. The usable comparison is per config and target: first on the target that round (the previous visit about 6 minutes earlier) versus 15 s after another browser. Each cell has only 5 first-visit trials.

| Config | Target | First on target that round | 15 s after a render | 15 s after a block |
|---|---|---:|---:|---:|
| chrome-headed | cloudflare-challenge | 2/5 | — | 13/15 |
| chrome-headed | perimeterx-therealreal | 5/5 | 5/5 | 10/10 |
| firefox-headed | perimeterx-therealreal | 5/5 | — | 15/15 |
| firefox-headed | datadome-leboncoin | 1/5 | — | 2/15 |
| firefox | perimeterx-therealreal | **5/5** | **0/15** | — |
| firefox | akamai-homedepot | 5/5 | — | 15/15 |
| firefox | datadome-leboncoin | 0/5 | 0/3 | 1/12 |

All other cells were uniform: always rendered or always blocked, regardless of position.

- **Fallback after a block was not penalized where it could be measured.** `chrome-headed` rendered Cloudflare 13/15 and TheRealReal 10/10 right after headless Firefox was blocked; `firefox-headed` rendered TheRealReal 15/15 right after headless Chrome was blocked.
- **One short-term penalty did show up, and not after a block.** Headless Firefox rendered TheRealReal 5/5 when first on it that round, and 0/15 when headed Firefox had *successfully* visited 15 s earlier. PerimeterX seems to flag a second fingerprint from the same IP in quick succession, at least when the second one is headless Firefox. With five first-visit samples this is suggestive, not established.
- **DataDome saturated.** Leboncoin was blocked for nearly every config in every position, so the run says nothing about DataDome and fallbacks.

The interleaving itself can penalize whichever config runs right after another one: that is the TheRealReal pattern above. That inflates headless Firefox's failure count on TheRealReal, so its 5/20 understates what it gets as the only browser on a site.

## Memory and CPU

One browser in its own systemd scope, read from its cgroup. A fresh context opened Wikipedia, an Amazon product, CNN and BBC News as four tabs, then idled 60 s. Two passes agreed within about 10%; Firefox figures include its Playwright launcher (bare node ≈ 9 MiB), and headed figures include Xvfb.

| Config | Browser, no tabs | 4 tabs (anon) | Peak | CPU to load | Idle CPU, 4 tabs |
|---|---:|---:|---:|---:|---:|
| fingerprint-chromium headless | 110 MiB | 845 MiB | 900 MiB | 17 s | 28% of a core |
| Chrome headless | 230 MiB | 420 MiB | 540 MiB | 4 s | 3% |
| Chrome headed | 280 MiB | 1.15 GiB | 1.5 GiB | 30 s | 50% |
| Firefox headless | 195 MiB | 1.23 GiB | 1.6 GiB | 35 s | 74% |
| Firefox headed | 217 MiB | 1.29 GiB | 1.75 GiB | 35 s | 74% |

Headless Chrome's numbers are low because sites blocked it: a follow-up check got Amazon's 146-character bot page and an empty CNN page, while headed Chrome got both in full. Headed Chrome costs about 1.35× fingerprint-chromium's memory and about 1.8× its CPU, mostly software compositing into Xvfb's framebuffer; one pass with a YouTube tab reached 121% of a core. Firefox costs more than either Chrome setup, headed or not.

## Sandboxing on akelly-desktop

- **Chrome and fingerprint-chromium** (checked by Adrian): every Chrome setup and fingerprint-chromium runs its GPU process without a seccomp sandbox (`Seccomp: 0`, `Sandboxed false` on `chrome://gpu`; Chrome logs "InitializeSandbox() called with multiple threads in process gpu-process"). Renderers are seccomp-sandboxed in all of them, and `chrome://sandbox` reports "adequately sandboxed". The Vulkan flags route web-reachable WebGL into the real AMD driver from that unsandboxed GPU process, a larger attack surface than SwiftShader.
- **Playwright Firefox**: Linux Firefox has no separate GPU process, so GPU work runs in the unsandboxed parent. Content, socket and media-decoder (RDD) processes are seccomp-filtered (`Seccomp: 2`) but share the parent's user, PID and network namespaces: no namespace layer. The likely cause is Ubuntu's restriction on unprivileged user namespaces, with no AppArmor profile attached to Playwright's Firefox path. An AppArmor profile like `browser-swarm-chromium` would probably restore namespaces (untested).
- **Playwright Firefox disables security updates.** Its prefs turn off Safe Browsing (malware, phishing, downloads, blocked URIs) and app, extension, GMP and search updates. `firefox-1555/firefox/playwright.cfg` sets `pref("services.settings.server", "data:,#remote-settings-dummy/v1")`, which blocks Remote Settings and with it CRLite and OneCRL certificate revocation; that matters more than Safe Browsing. Because it is a `pref()`, not a `lockPref()`, overriding `services.settings.server` through the controller's `firefoxUserPrefs` would likely restore revocation updates (untested). Production Firefox runs this way today. Playwright's Firefox also updates only when browser-swarm bumps Playwright; it does not auto-update.

## Which default fits browser-swarm

**Linux: switch to Google Chrome headed in Xvfb.** It rendered 75/100, against 46 for the best alternative, with no consistency leaks, no crashes, and current Chrome with CRLSet and Safe Browsing live. It beat fingerprint-chromium on every target in the shared reference run except Cloudflare. Costs: about 1.35× memory and 1.8× CPU per tab set. At the 10-agent × 2-tab fan-out that is roughly 5.7 GiB instead of 4.2 GiB on a 15 GiB machine where systemd-oomd already kills a second LLM, plus an Xvfb process and the unsandboxed-GPU exposure above. A production switch also needs the Vulkan flags, the controller managing Xvfb, and a decision on whether to keep the seed-based fingerprint (Chrome has none: it exposes the real Linux host).

**Mac: headless only, and no measured option is clearly good.** Headless Chrome is the worst config here (20/100, `HeadlessChrome` UA). Headless Firefox (46/100) and headless fingerprint-chromium (21/43 in the reference run) split the targets: Firefox renders Akamai and fingerprint-chromium doesn't (0/8 here, 0/20 in August); fingerprint-chromium renders Cloudflare and Firefox doesn't (0/20). Firefox is fresher but leaks `navigator.webdriver` and ships with revocation updates off; fingerprint-chromium is 8 milestones stale and crashed on a quarter of DataDome visits. A same-run Mac comparison is needed before choosing. An untested middle path is headless Chrome with the UA fixed through CDP's `Network.setUserAgentOverride` with matching client hints, which removes its most obvious leak while staying current.

**Headed vs headless.** Headed wins decisively for Chrome. For Firefox it trades Akamai for PerimeterX and adds a software-WebGL leak, so headed Firefox has no reason to exist.

**Chrome vs Firefox.** On Linux, headed Chrome dominates Firefox in either mode except Leboncoin (0 vs 3/20), which no config renders reliably. Firefox's remaining role is the Mac and Akamai.

**Per-site choice.** On Linux with headed Chrome as default it adds almost nothing: headed Chrome already covers Akamai, PerimeterX and Hermès. On the Mac it is worth having, because the headless options split Cloudflare and Akamai between them; browser-swarm already offers that split as the `browser-swarm-firefox` agent. Falling back after a block was not penalized here, so retrying with the other browser is reasonable; avoid switching on a site that *rendered*, since a second fingerprint 15 s after a success is what PerimeterX punished.
