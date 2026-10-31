# Bot detection and browser engines

Many sites put a bot-detection system — Cloudflare, Akamai, DataDome, and similar — in front of their content. These systems are tuned to flag automated traffic, and a stock headless browser can receive a challenge or a blank shell instead of the page. This doc covers which engine gets through which system, how to tell which system a site is running, and why the default browser is Google Chrome.

Findings were measured on live commercial sites from July to October 2026. Detection vendors tune continuously, so treat the ratings as a starting point and re-probe when a site that used to render stops rendering.

## Which engine renders on which system

| Detection system | Path | Confidence |
|---|---|---|
| None / light | Shared headless Chrome | — |
| Cloudflare managed challenge | Headed Chrome; headless engines are challenged | live-confirmed |
| **Akamai** | Headed Chrome or headless Firefox | live-confirmed, both |
| **DataDome**, alone or stacked | Nothing renders reliably. Skip the browser | live-confirmed negative |
| **PerimeterX** | Headed Chrome or headed Firefox | live-confirmed |

On Linux, headless Chrome contexts reach headed Chrome by themselves: the controller learns which sites block headless Chrome (see the README).

**No headless browser gets a real page from production DataDome.** Five configurations — plain Playwright Firefox, camoufox, tf-playwright-stealth-firefox, cloakbrowser, and cloakbrowser driven by patchright — were 403'd identically on live DataDome sites, despite several of them passing DataDome in the [browsers-benchmark](https://github.com/techinz/browsers-benchmark) suite. That benchmark's DataDome targets are the vendor's own marketing site and a fashion retailer, both far more permissive than a distributor protecting pricing and inventory. `cloakbrowser` is the decisive case: it scores well headless in the benchmark and still returns a `captcha-delivery` challenge on every real vendor. Don't spend time hunting a headless DataDome path.

DataDome is also **adaptive** — a site served a first-hit 200 to a bare probe, then 403'd focused repeat visits. A single 200 is not proof a site renders reliably; probe more than once.

**Akamai is the opposite case:** several engines render on it. Headless Firefox is the cheapest; headed Chrome renders it too, headless Chrome does not.

Where a browser isn't strictly required, the more reliable path is not to drive the protected HTML at all: sites' own JSON APIs — platform cart and rate endpoints, search APIs — stay open, because blocking them would break the site itself.

## Why Google Chrome

Google Chrome stable is current, updates itself, keeps CRLSet revocation updates, and reports the `Google Chrome` brand in client hints, which Playwright's bundled Chromium does not. Patched builds like fingerprint-chromium and cloakbrowser lag Chrome by several milestones and carry their own bugs; fingerprint-chromium crashed its renderer on a quarter of DataDome visits.

Headed matters for Chrome. On five protected targets, headed Chrome in Xvfb rendered 75/100 trials against 20/100 for headless Chrome with its `HeadlessChrome` user agent, and headed Chrome costs about 2.7× the memory and much more CPU. See [the October 2026 comparison](reports/2026-10-31-chrome-firefox-headed.md). BrowserSwarm therefore runs headless Chrome with the user agent corrected and moves a site to headed Chrome only after it blocks headless. LIVE_CHECK_PLACEHOLDER

Headless Chrome's only fingerprint leak is the user agent string; its client hints and WebGL (on the host GPU through Vulkan) match headed Chrome. The controller replaces `HeadlessChrome` with `Chrome` through Playwright's context UA override, which covers frames, workers and popups. Playwright derives the client-hint metadata it sends from the UA string. On Linux that matches real Chrome exactly. On macOS the frozen UA `Intel Mac OS X 10_15_7` makes high-entropy hints report `architecture "x86"` and `platformVersion "10_15_7"`, where real Chrome on Apple silicon reports `arm` and the macOS version.

[`tests/fingerprint-compare.mjs`](../tests/fingerprint-compare.mjs) compares browser configurations side by side. All configs stay open for the whole run; each round visits every target once per config, rotating config order, so network conditions and IP reputation hit every config alike. `chrome` and `chrome-headed` launch Google Chrome with the controller's own flags and user agent. `firefox` and `firefox-headed` run Playwright's Firefox the way the Firefox backend does. `stock` runs Playwright's bundled Chromium; install it with `node_modules/.bin/playwright install chromium`. Headed configs run on Linux and draw on the inherited `DISPLAY`, so run them under `xvfb-run -a -s '-screen 0 1920x1080x24'`; headless configs launch without `DISPLAY`, since headless Firefox gains WebGL when one is set. Each trial gets a fresh context and appends its result to JSONL before the next delay. The completed run renders a Markdown report:

```sh
xvfb-run -a -s '-screen 0 1920x1080x24' node tests/fingerprint-compare.mjs run \
  --configs chrome-headed,chrome,firefox-headed,firefox \
  --targets cloudflare-challenge,datadome-leboncoin,datadome-stacked-hermes,perimeterx-therealreal,akamai-homedepot \
  --trials-per-target 20 \
  --spacing-seconds 15 \
  --settle-seconds 8 \
  --jsonl results.jsonl \
  --report docs/reports/comparison.md
```

Targets may be built-in names or `label=https://url`. Built-in protected targets: `cloudflare-challenge` (managed challenge), `akamai-homedepot`, `datadome-leboncoin` (DataDome alone; renders a few times then 403s the IP+fingerprint pair), `datadome-stacked-hermes` (DataDome behind Cloudflare), and `perimeterx-therealreal`. `amazon` and `google` do not challenge stock headless at low rates and only serve as render checks. The settle window defaults to eight seconds. The script classifies pages with the controller's classifier ([`src/challenge.ts`](../src/challenge.ts)) and also counts a renderer crash, a navigation error, a 5xx and any change of host as failures. Recover a report from an interrupted run with `node tests/fingerprint-compare.mjs report --jsonl results.jsonl --report report.md`. Consistency leaks flag a platform mismatch between UA, `navigator.platform`, and client hints, a `HeadlessChrome` UA, `navigator.webdriver`, and a missing or software WebGL renderer.

Two configuration notes that apply to any Chromium driven by Playwright:

- **Drop `--enable-automation`.** Playwright's launcher adds it and it exposes `navigator.webdriver`. Launching the browser yourself and attaching over CDP avoids it, as do `ignoreDefaultArgs: ["--enable-automation"]` in a Playwright MCP `--config` launch block.
- **Set the viewport explicitly.** A viewport larger than the browser's window produces `outerWidth < innerWidth`, a physically impossible window.

## Playwright itself is detectable

Every stock Playwright page — launched or attached — gets `Runtime.enable`, `Log.enable`, `Page.createIsolatedWorld`, and `Page.addScriptToEvaluateOnNewDocument` during frame-session init. Detection vendors probe these directly; the `rebrowser-bot-detector` suite names two of them `runtimeEnableLeak` and `pwInitScripts`. This is a floor on how closely any Playwright-driven browser can resemble a hand-driven one.

[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a fork of playwright-core, lowers that floor: it derives the execution context from a `Runtime.evaluate` object handle instead of subscribing to context-created events, which removes `Runtime.enable` from the Chromium page path entirely. Because that change lives in code the attach path funnels through, it applies over `connectOverCDP` as well as on launch — measured, `Runtime.enable` calls drop from 5 to 0 with no browser-side change. It swaps in mechanically, since patchright-core exports the same surface as playwright-core including the MCP entry points.

Measured against live detection systems, though, patchright renders no better and fails the same vendors, because these systems key on browser-layer signals patchright by design does not touch. It also costs real things: you inherit the MCP version bundled in patchright's core, `Console.enable` is disabled so console tooling degrades, and main-world globals become unreadable from `evaluate`, which breaks the common "read a value the page set" pattern. Worth knowing about; not worth adopting by default.

One engine family this rules out entirely: **CDP-minimal drivers — zendriver, nodriver, selenium-driverless — get their low profile from *not sending* those commands, so attaching Playwright to one destroys the property it exists to provide.** Worse, it isn't containable: `connectOverCDP` issues `Target.setAutoAttach` with no target-type filter, so Playwright initializes every existing and future page in that browser, including tabs the native driver is using.

## What the MCP can drive

- **CDP is Chromium-only.** Firefox contexts connect to the shared `firefox.launchServer()` process through Playwright's WebSocket protocol instead. Each one still gets an isolated context on that browser.
- **`--browser` accepts only `chrome`, `firefox`, `webkit`, `msedge`,** but **`--config` exposes the full Playwright `launchOptions`** — `executablePath`, `args`, `ignoreDefaultArgs`, `env`, plus `contextOptions`. Any engine whose configuration is a patched binary plus launch flags is therefore reachable from the MCP alone, with no second driver process.
- **`--endpoint <ws url>`** connects to an existing Playwright server (`browserType.connect()`), not a CDP endpoint. Unlike `--cdp-endpoint` this is browser-agnostic, so it's the hook for any engine that can expose a Playwright server.
- **`--init-script <path>`** adds JavaScript evaluated in every page before the page's own scripts; **`--init-page <path>`** evaluates TypeScript against the Playwright page object, which is the escape hatch for anything the page context can't do, such as `setExtraHTTPHeaders`.
- **`--user-agent`** sets the real context UA, on the wire and in JS, including workers, because it routes through `Emulation.setUserAgentOverride` with metadata Playwright derives from the string; Chrome fills in brands and full versions. Chrome's **own** `--user-agent` command-line flag is a trap by comparison: it changes the string while leaving low-entropy client hints reporting real values and blanking every high-entropy hint, a combination no genuine Chrome produces. Use the MCP flag, never the browser flag.

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

Headed helps Chrome, not every engine. Headed Firefox rendered no more than headless Firefox and lost Akamai, which headless Firefox renders.

macOS has no Xvfb equivalent and no way to render a headed Chromium invisibly — Chrome for macOS has no Ozone/X11 backend, offscreen window positions are clamped back on screen, and hiding or minimizing the window makes screenshot capture time out. The only genuine invisible-headed route is a second user account left logged in via fast user switching, which costs a full GUI session's memory. Short of that, a headed app can be driven *behind* the current window via macOS SkyLight APIs, at the cost of GUI/vision-level driving — slow, token-heavy, and less deterministic than DOM and CDP. BrowserSwarm on macOS therefore runs headless only.

## Basis

Engine-vs-system scores come from a single [browsers-benchmark](https://github.com/techinz/browsers-benchmark) run (23 engine configs × 10 targets, n=1 per target — a snapshot, not a constant), corrected by live probes against commercial sites where the two disagreed. The benchmark's DataDome results in particular do not survive contact with real sites, which is why the tables above lead with live evidence.
