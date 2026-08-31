# Bot detection and browser engines

Many sites put a bot-detection system — Cloudflare, Akamai, DataDome, and similar — in front of their content. These systems are tuned to flag automated traffic, and a stock headless browser can receive a challenge or a blank shell instead of the page. This doc covers which engine gets through which system, how to tell which system a site is running, and why the daemon's default browser is fingerprint-chromium.

Findings were measured on live commercial sites in July 2026. Detection vendors tune continuously, so treat the ratings as a starting point and re-probe when a site that used to render stops rendering.

## Which engine renders on which system

| Detection system | Path | Confidence |
|---|---|---|
| None / light | The shared fingerprint-chromium daemon | — |
| Cloudflare | Usually just CDN, not a challenge. Try the daemon first, escalate only on a real interstitial | untested in depth |
| **Akamai** | Shared fingerprint-Chromium or shared headless Firefox | live-confirmed, both |
| **DataDome**, alone or stacked | No headless engine renders. Skip the browser | live-confirmed negative |
| **PerimeterX** | Behaves like DataDome; headless Firefox is blocked | one live data point |

**No headless browser gets a real page from production DataDome.** Five configurations — plain Playwright Firefox, camoufox, tf-playwright-stealth-firefox, cloakbrowser, and cloakbrowser driven by patchright — were 403'd identically on live DataDome sites, despite several of them passing DataDome in the [browsers-benchmark](https://github.com/techinz/browsers-benchmark) suite. That benchmark's DataDome targets are the vendor's own marketing site and a fashion retailer, both far more permissive than a distributor protecting pricing and inventory. `cloakbrowser` is the decisive case: it scores well headless in the benchmark and still returns a `captcha-delivery` challenge on every real vendor. Don't spend time hunting a headless DataDome path.

DataDome is also **adaptive** — a site served a first-hit 200 to a bare probe, then 403'd focused repeat visits. A single 200 is not proof a site renders reliably; probe more than once.

**Akamai is the opposite case:** several engines render on it headless. Plain Firefox is the cheapest and needs no fingerprint patch at all. Where the engine has to be Chromium, fingerprint-chromium renders on both the benchmark's Akamai target and a live Akamai-only vendor.

Where a browser isn't strictly required, the more reliable path is not to drive the protected HTML at all: sites' own JSON APIs — platform cart and rate endpoints, search APIs — stay open, because blocking them would break the site itself.

## Why fingerprint-chromium

[fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) is BSD-3 licensed, tracks a recent Chromium, ships macOS arm64 and Linux x86_64 builds, and removes the `HeadlessChrome` product name in C++ unconditionally. It also disables `Runtime.enable` in the binary, which is more durable than a driver-side change since no client upgrade can undo it.

Its main fork, cloakbrowser, scores the same overall headless on the same targets, differing only on which individual sites render; the upstream is slightly lighter. The persistent fingerprint seed derives GPU vendor and renderer values. Current builds removed the manual GPU flags.

[`tests/fingerprint-compare.mjs`](../tests/fingerprint-compare.mjs) measures ordered platform and display configurations with one seed. `stock` runs Playwright's bundled Chromium without fingerprint flags; install that control with `node_modules/.bin/playwright install chromium`. `linux-headed` runs the Linux fingerprint in a 1920×1080 Xvfb display and requires `xvfb-run` and `Xvfb` on `PATH`. Each trial gets a fresh context and appends its result to JSONL before the next delay. The completed run renders a Markdown report:

```sh
node tests/fingerprint-compare.mjs run \
  --configs macos,windows \
  --targets cloudflare-challenge,datadome-leboncoin,datadome-stacked-hermes,perimeterx-therealreal,akamai-homedepot \
  --trials-per-target 20 \
  --spacing-seconds 15 \
  --cooldown-seconds 3600 \
  --settle-seconds 8 \
  --jsonl results.jsonl \
  --report docs/reports/fingerprint-platform.md
```

Targets may be built-in names or `label=https://url`. Built-in protected targets: `cloudflare-challenge` (managed challenge), `akamai-homedepot`, `datadome-leboncoin` (DataDome alone; renders a few times then 403s the IP+fingerprint pair), `datadome-stacked-hermes` (DataDome behind Cloudflare), and `perimeterx-therealreal`. `amazon` and `google` do not challenge stock headless at low rates and only serve as render checks. The settle window defaults to eight seconds. Recover a report from an interrupted run with `node tests/fingerprint-compare.mjs report --jsonl results.jsonl --report report.md`. Reverse config order on the next day. Choose the platform with the most rendered trials on protected sites and no consistency leaks; ties go to `macos` so both hosts expose one identity.

Two configuration notes that apply to any patched Chromium driven by Playwright:

- **Drop `--enable-automation`.** Playwright adds it by default and it exposes `navigator.webdriver`. Via the MCP that means `ignoreDefaultArgs: ["--enable-automation"]` in a `--config` launch block.
- **Set the viewport explicitly.** Playwright's emulated default produces `outerWidth < innerWidth`, a physically impossible window.

## Playwright itself is detectable

Every stock Playwright page — launched or attached — gets `Runtime.enable`, `Log.enable`, `Page.createIsolatedWorld`, and `Page.addScriptToEvaluateOnNewDocument` during frame-session init. Detection vendors probe these directly; the `rebrowser-bot-detector` suite names two of them `runtimeEnableLeak` and `pwInitScripts`. This is a floor on how closely any Playwright-driven browser can resemble a hand-driven one.

[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a fork of playwright-core, lowers that floor: it derives the execution context from a `Runtime.evaluate` object handle instead of subscribing to context-created events, which removes `Runtime.enable` from the Chromium page path entirely. Because that change lives in code the attach path funnels through, it applies over `connectOverCDP` as well as on launch — measured, `Runtime.enable` calls drop from 5 to 0 with no browser-side change. It swaps in mechanically, since patchright-core exports the same surface as playwright-core including the MCP entry points.

Measured against live detection systems, though, patchright renders no better and fails the same vendors, because these systems key on browser-layer signals patchright by design does not touch. It also costs real things: you inherit the MCP version bundled in patchright's core, `Console.enable` is disabled so console tooling degrades, and main-world globals become unreadable from `evaluate`, which breaks the common "read a value the page set" pattern. Worth knowing about; not worth adopting by default.

One engine family this rules out entirely: **CDP-minimal drivers — zendriver, nodriver, selenium-driverless — get their low profile from *not sending* those commands, so attaching Playwright to one destroys the property it exists to provide.** Worse, it isn't containable: `connectOverCDP` issues `Target.setAutoAttach` with no target-type filter, so Playwright initializes every existing and future page in that browser, including tabs the native driver is using.

## What the MCP can drive

- **CDP is Chromium-only.** Firefox agents connect to the shared `firefox.launchServer()` daemon through Playwright's WebSocket protocol instead. Each MCP client still gets an isolated context on one browser process.
- **`--browser` accepts only `chrome`, `firefox`, `webkit`, `msedge`,** but **`--config` exposes the full Playwright `launchOptions`** — `executablePath`, `args`, `ignoreDefaultArgs`, `env`, plus `contextOptions`. Any engine whose configuration is a patched binary plus launch flags is therefore reachable from the MCP alone, with no second driver process.
- **`--endpoint <ws url>`** connects to an existing Playwright server (`browserType.connect()`), not a CDP endpoint. Unlike `--cdp-endpoint` this is browser-agnostic, so it's the hook for any engine that can expose a Playwright server.
- **`--init-script <path>`** adds JavaScript evaluated in every page before the page's own scripts; **`--init-page <path>`** evaluates TypeScript against the Playwright page object, which is the escape hatch for anything the page context can't do, such as `setExtraHTTPHeaders`.
- **`--user-agent`** sets the real context UA, on the wire and in JS, because it routes through `Network.setUserAgentOverride` with matching metadata. Chromium's **own** `--user-agent` command-line flag is a trap by comparison: it changes the string while leaving low-entropy client hints reporting real values and blanking every high-entropy hint, a combination no genuine Chrome produces. Use the MCP flag, never the browser flag.

## Identifying the detection system

Load the homepage and inspect cookies, headers, body, and the **final URL**. The MCP reports HTTP status in its navigate result.

**Never key a detector on "403 means blocked."** Most systems don't use it. AWS WAF's challenge is **202** with an often-empty body, which naive clients read as success; its CAPTCHA is **405**. Kasada's normal first challenge is **429**. Fastly's Next-Gen WAF blocks with **406**. Radware Bot Manager and Queue-it never return a non-2xx at all — they redirect to another host. Imperva sometimes serves its block page under a plain **200**. A short body with an empty title and a 200 status is a block until proven otherwise; check the body, the final host, or a screenshot.

| System | Markers | Headless |
|---|---|---|
| Akamai Bot Manager | cookies `_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`, `bm_lso`; body `bazadebezolkohpepadr` or an `/akam/` script. `Server: AkamaiGHost` is Kona Site Defender, a different product | renders — see the table above |
| DataDome | cookie `datadome`; body `captcha-delivery` or `dd={` | hard; no headless engine renders |
| Cloudflare | cookies `__cf_bm`, `cf_clearance`, header `cf-ray` — often only CDN. Turnstile: `challenges.cloudflare.com/turnstile/v0/api.js`. Waiting Room: cookie `__cfwaitingroom` | usually renders |
| PerimeterX / HUMAN | cookies `_px*`, `pxcts` | hard |
| AWS WAF | cookie `aws-waf-token`, header `X-Aws-Waf-Token` cross-origin; response header `x-amzn-waf-action: challenge\|captcha`; **status 202 (challenge) or 405 (CAPTCHA)**; any script from `*.awswaf.com`; body `window.gokuProps`, `awsWafCookieDomainList`, `id="challenge-container"` | varies more than any other: Common level blocks on static signals like a `HeadlessChrome` UA with no JS at all, Targeted level fingerprints and is a genuine hard block |
| Imperva / Incapsula | headers `X-Iinfo`, `X-CDN: Incapsula`; cookies `incap_ses*`, `visid_incap*`, `reese84`, `___utmvc`; path `/_Incapsula_Resource`; body `Incapsula incident ID` | medium-hard; **block pages sometimes served as 200** |
| Kasada | cookies `KP_UIDz`, `KP_UIDz-ssn`; headers `x-kpsdk-ct`, `x-kpsdk-cd`, `x-kpsdk-st`; script `ips.js` with sibling `/tl`, `/fp`, `/mfc` | hard — arguably the hardest here |
| F5 Shape / Bot Defense | no fixed literal. Detect structurally: a cluster of same-prefix random-alnum headers on XHR and form POSTs, e.g. `x-<5-10 alnum>-a`, `-b`, `-c` | hard, and hard even to identify — its JS is a bytecode VM |
| F5 BIG-IP ASM | cookie `TS[a-fA-F0-9]{6,8}`; `Server: big-ip`; body "the requested url was rejected" | easy-moderate |
| Radware Bot Manager | **302 to `validate.perfdrive.com`**, query `ssk=support@shieldsquare.com` (constant, sufficient alone); title `Radware Captcha Page` | medium, but diverts to a 200 CAPTCHA page rather than blocking — silently ingested as success |
| Queue-it | script `static.queue-it.net/script/queueclient.min.js`; cookie `QueueITAccepted-SDFrts345E-V3_*`; pre-queue `botdetect.min.js` | the queue is trivial; the pre-queue bot check flags headless directly |
| Fastly Next-Gen WAF | **status 406** plus `X-Fastly-Request-ID` / `Server: Fastly` | easy-moderate, a rules WAF rather than a JS challenge |
| Sucuri, Reblaze, Barracuda | `X-Sucuri-ID` / `X-Sucuri-Block`; cookie `rbzid`; cookie `BNI__BARRACUDA_LB_COOKIE` | easy |

**Check the final host.** Radware Bot Manager (`*.perfdrive.com`) and Queue-it (`*.queue-it.net`) are reached by redirect rather than an inline block, so a 200 from an unexpected host is the whole signal.

**Netacea leaves no client-side trace at all.** It is agentless and inspects traffic at the infrastructure level, so a protected site is indistinguishable from an unprotected one from the client. Absence of every marker above is not proof a site is unprotected.

Response headers like `x-amzn-waf-action` are not readable from in-page `fetch()` — read them from the network layer (`response.headers()` in Playwright, a proxy, or a raw HTTP client).

## Headed browsers

Every one of these systems is dramatically easier headed than headless: in the browsers-benchmark run, patchright headed renders on 10/10 targets while headless Chromium renders on no Akamai target at all.

That doesn't rescue background agents on macOS, which has no Xvfb equivalent and no way to render a headed Chromium invisibly — Chrome for macOS has no Ozone/X11 backend, offscreen window positions are clamped back on screen, and hiding or minimizing the window makes screenshot capture time out. The only genuine invisible-headed route is a second user account left logged in via fast user switching, which costs a full GUI session's memory. Short of that, a headed app can be driven *behind* the current window via macOS SkyLight APIs, at the cost of GUI/vision-level driving — slow, token-heavy, and less deterministic than DOM and CDP.

## Basis

Engine-vs-system scores come from a single [browsers-benchmark](https://github.com/techinz/browsers-benchmark) run (23 engine configs × 10 targets, n=1 per target — a snapshot, not a constant), corrected by live probes against commercial sites where the two disagreed. The benchmark's DataDome results in particular do not survive contact with real sites, which is why the tables above lead with live evidence.
