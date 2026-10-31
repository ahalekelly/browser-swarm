# BrowserSwarm

BrowserSwarm gives concurrent agents isolated browser contexts on shared browser processes: headless Google Chrome by default and Firefox as a fallback. On Linux, a site that blocks headless Chrome moves to headed Chrome in a virtual display, without the agent noticing. A fan-out pays for contexts instead of full browser processes.

A controller service owns the browsers and every context. Agents open and drive a context from the shell with the `swarm` CLI, so nothing browser-related runs inside the agent harness and concurrent agents have nothing to share. The standard pinned [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) supplies the tools; each context is one of its processes, started and owned by the controller.

Supported hosts: macOS on Apple silicon and Linux on x86_64. Node.js 22.18 or newer is required for direct TypeScript execution. Linux needs Google Chrome stable from [Google's apt repository](https://www.google.com/linuxrepositories/) and Xvfb (`sudo apt install google-chrome-stable xvfb`); on macOS the installer adds Chrome with Homebrew. Chrome updates itself.

## Install

```sh
git clone https://github.com/ahalekelly/browser-swarm.git ~/.browser-swarm
cd ~/.browser-swarm
./install.sh
```

`install.sh` fast-forwards the checkout, runs `npm ci`, checks for Chrome, installs the pinned Firefox, installs and starts the controller service, and generates the Claude Code and Codex agent definitions. Run it again in the clone to update. The generated agent definitions embed absolute paths into the clone, so leave it where it is.

The Playwright package checksum in `package-lock.json` pins its browser registry, and `install-playwright-firefox.sh` verifies the expected Playwright version, Firefox revision, and installed executable. `package.json` overrides `@playwright/mcp`'s Playwright dependency with the newest stable release, which bundles the MCP server and the newest Firefox.

## Use

```sh
id=$(./swarm open)                                    # ./swarm open firefox for the fallback
./swarm "$id" navigate '{"url":"https://example.com"}'
./swarm "$id" snapshot
./swarm "$id" close
```

`open` prints the context id on stdout and its output directory on stderr, so `$( )` captures the id alone. Tool names drop Playwright MCP's `browser_` prefix. `./swarm "$id" tools` lists them with one line of description each, and `./swarm "$id" help <tool>` prints one tool's schema, so a session never needs every schema up front. Pass `-` in place of the JSON arguments to read them from stdin, which avoids shell quoting trouble for long text.

Exit codes: 0 success, 1 the tool reported an error, 2 usage, 3 controller or transport failure, 4 unknown or expired context.

`./swarm ls` lists open contexts with their browser, age, idle time, output dir and page URLs. `./swarm status` reports each browser, the last crash, and the sites learned to need headed Chrome.

### Saved sessions

`./swarm open [firefox] --session <name>` opens an isolated context preloaded with the cookies and localStorage saved under `<name>`. `swarm <id> close` saves its state back, so refreshed cookies persist; idle expiry and a controller restart discard it unsaved. A new name starts logged out and is created on close. Contexts opened without `--session` never see saved state. Several contexts may share a session; the last to close wins. Names use `a-z`, `0-9` and `-`. A close that cannot save exits 3.

Sessions are credentials. They live in `sessions/<name>.json` in the checkout (gitignored, directory mode 700, files 600); delete a file to forget a session. The modes keep out other users, not agents running as you. An agent in a session context can see its cookies, through `evaluate` or network request headers. The controller withholds Playwright MCP's cookie, localStorage and storage-state tools only so that no tool dumps them wholesale.

A human logs in, never an agent. `swarm login` opens a page in a session context, keeps it alive while you log in through DevTools, and saves the session when you press Enter. From another machine, tunnel the CDP port and run it over the same SSH connection:

```sh
ssh -t -L 9377:127.0.0.1:9377 <host> <checkout>/swarm login facebook https://www.facebook.com/login
```

1. In a Chromium-based browser (Chrome, Vivaldi), open `chrome://inspect/#devices`, check **Discover network targets**, and add `localhost:9377` under **Configure…**. A site that opens in headed Chrome is on port 9379 instead; `login` prints the port, so tunnel that one.
2. Under **Remote Target**, find the page on your login URL and click **inspect fallback** (or **inspect**, which downloads the DevTools build matching the remote Chromium). DevTools shows the page live on its left; click and type into it there. The list holds every agent's pages, so pick only yours.
3. Log in, finish 2FA, then press Enter in the terminal.

Ctrl-C or a dropped connection leaves the saved session as it was. `login` refuses while another context has the session open, because that context's close would overwrite the new login.

The tunnel keeps port 9377 loopback-only on the host. While it is up, anything on your machine that reaches local port 9377 can drive the shared browser, so close it after logging in.

The controller runs as a user service and only picks up new code or a new `node` binary when restarted:

```sh
systemctl --user restart browser-swarm   # Linux; journalctl --user -u browser-swarm for logs
./install-controller-service.sh          # macOS; logs in controller.log
```

## Tests

```sh
npm test               # fake browser and fake Playwright MCP; no browser starts
npm run test:chrome    # the real gate on Google Chrome, headless and headed
npm run test:firefox   # the real gate on Playwright Firefox
```

Every suite builds a private fixture — a copy of `src/` with its ports, output root and five-minute timers rewritten — so nothing touches the machine-wide controller. The real gates start browsers and need an ordinary shell; inside an agent sandbox Chrome exits during startup.

## Agent definitions

[`claude-agents/`](claude-agents/) generates two definitions in `~/.claude/agents/`:

- `browser-swarm`: Chrome for normal browser work.
- `browser-swarm-firefox`: Firefox for sites confirmed to block Chrome.

They carry no MCP server. The agent runs `swarm` from Bash, which is why any number of them can work at once: [claude-code#84638](https://github.com/anthropics/claude-code/issues/84638) makes stock Claude Code route concurrent subagents that declare the same inline MCP server through one session, and the first subagent to finish closes it under its siblings. Nothing per-agent runs in the harness now, so there is nothing for the harness to share. Both definitions still withhold the `Agent` tool: a browser task is cheap to do and expensive to delegate. The Claude definition also withholds `Skill`: skills are orchestrator playbooks, and a worker that loads one abandons its browser task.

[`codex-agents/`](codex-agents/) generates one `browser-swarm` definition and registers `swarm mcp chrome` as the `playwright` MCP server. Codex's command sandbox blocks all network access, so its agents cannot call the CLI; the adapter owns one context per MCP session and forwards tool calls to the controller. Start a new Codex session after installation.

Both families splice [agent-prompt.md](agent-prompt.md) and the harness's own tooling paragraph.

## Operating rules

**Keep fan-outs to about 10 concurrent browser agents.** Each isolated context uses roughly 100–200 MB under the 2-tab cap. This is a resource guideline, not a type-allocation rule.

**Keep at most 2 tabs open per context.** Close each tab as soon as its content is extracted. A 14-tab session reached about 6 GB RSS and froze the machine.

**Reach for a browser last.** Prefer a purpose-built API, then web search. Use a browser for forms, configurators, authenticated flows, and sites that starve cheaper paths.

**Close contexts, not the service.** `swarm <id> close` is the end of an agent's work. The controller stays up; it stops a browser five minutes after its last context goes away and starts it again when a context next needs it.

**Relaunch after an idle disconnect.** A context is released after five minutes with no calls; in-flight work suspends that lease. A fresh agent gets a fresh isolated context.

## How it works

**One service, three browsers.** The controller listens on `127.0.0.1:9387` and launches each browser when a context first needs it: headless Chrome on CDP port 9377, headed Chrome on port 9379 (Linux only), both at low priority (`taskpolicy -c utility` on macOS, `nice -n 10` on Linux), and Playwright's managed Firefox through `firefox.launchServer()` at `ws://127.0.0.1:9378/browser-swarm`. Plain `launchServer` is load-bearing: shared-browser mode disables per-client context isolation. All launch muted, so pages never play audio through the machine's speakers. A cold first-run profile gets 120 seconds to answer, and a browser that dies takes its contexts with it — the next `open` relaunches it and `swarm status` reports the crash.

**How Chrome runs.** The controller starts Chrome itself rather than through Playwright's launcher, so none of Playwright's automation defaults apply: no `--enable-automation`, and the component updater and background networking stay on, so CRLSet certificate-revocation updates arrive. It turns off sync, translation, Media Router, autofill server queries, optimization hints and on-device AI model downloads, the first-run and default-browser prompts, and Safe Browsing (a profile pref, since Chrome has no switch for it). Field trials stay on, because disabling them changes the fingerprint. On Linux, `--use-angle=vulkan --enable-features=Vulkan` gives WebGL the host GPU, which Xvfb lacks. Headless Chrome names itself `HeadlessChrome` in its user agent, so each headless context gets Playwright's UA override with `Chrome` instead; its client hints already report Google Chrome. The viewport is an explicit 1280×720.

**Headed Chrome for sites that need it (Linux).** After a call lands a headless context on a new page, the controller reads the page's status, title and text and checks them for a bot challenge or block, with the classifier [the comparison script](docs/bot-detection.md) uses. A page still challenged five seconds later marks its registrable domain as needing headed Chrome for 30 days, in `headed-sites.json` (gitignored). After a ten-second pause the controller moves the context to headed Chrome and repeats the navigation there, and the agent gets the headed result as its tool response. Later navigations to a learned domain move the context before loading. A move carries cookies and localStorage, minus bot-detection vendors' cookies, which are bound to the browser that earned them; tabs close, which a navigation makes harmless. A context stays on headed Chrome until it closes. Headed Chrome draws into its own Xvfb display, which starts and stops with it. It costs about 2.7× headless Chrome's memory and far more CPU, which is why it serves only learned sites. macOS has no invisible headed mode, so the Mac runs headless only.

**Contexts are child processes.** Each context is a `@playwright/mcp` process with `--isolated`, its own output dir and the backend's endpoint. Playwright MCP cannot be embedded in a long-lived process: every initialized context installs a process-wide `unhandledRejection` listener, its `browser.once('disconnected')` listeners outlive cleanup, and `server.close()` leaves a supplied context open. A child process per context is also exactly the isolation the real gates test.

**Serialization, leases and deadlines.** Calls to one context run one at a time because Playwright MCP mutates selected-tab and running-tool state per call; different contexts run concurrently. A call has a 120-second deadline, after which the child is killed and the context is reported lost. A context's lease renews when a call finishes, so in-flight work and a disconnected client never make live work look idle. Five idle minutes closes the child and keeps the output dir.

**Reaching the controller from a sandbox.** Inside Claude Code's Linux bash sandbox, loopback is a separate network namespace and unix-socket `connect` is blocked, so a direct request cannot reach the host. The sandbox's HTTP proxy does, when the client ignores `no_proxy`. The CLI switches to that proxy only when `CLAUDE_CODE_HOST_HTTP_PROXY_PORT` is set — `http_proxy` alone would also be set by a corporate proxy, whose loopback is a different machine's. Proxy credentials are percent-decoded into Basic auth for the proxy, never forwarded to the controller and never printed in an error. The proxy reaches an existing listener only, which is why the controller is a service rather than something an agent starts.

**The API's security boundary.** Loopback binding is not one: a page the swarm browser loads can reach port 9387. The controller writes a fresh random token to `controller-token` (mode 600) once it is listening, and rejects any request without it, with an unexpected `Host`, without `content-type: application/json`, with a body over 1 MiB, or outside its five routes. The token file appearing is also what tells a client the controller is ready.

**Two tools are withheld.** `browser_run_code_unsafe` executes arbitrary JavaScript in the Playwright process and is RCE-equivalent; `browser_close` disposes backend state without closing the supplied context, so it would collide with `swarm <id> close`. `@playwright/mcp` filters tools only by capability and both are `core` tools, so the controller drops them from `tools/list` and refuses them in `tools/call`. The Codex adapter adds back a `browser_close` that means "close this context".

**Artifacts.** Each context gets `/tmp/claude/swarm/<id>/` (mode 700) as both its output dir and its working directory, which is the workspace root Playwright MCP restricts file access to. Results link an artifact relative to that root (`[screenshot](./page-….png)`) and the prompt tells agents to resolve links against the output dir. Screenshots use `imageResponses: 'omit'`, so the result is a path an agent reads with its own image-capable tool. Output dirs outlive their contexts by a day: the controller deletes a closed context's dir 24 hours after its last write. A result over 200 lines is saved there in full and previewed in the first 100 lines. Context ids are 16 hex characters because those dirs make ids collide over the controller's whole history, not just among live contexts.

**Saved sessions.** A session context's child gets `--storage-state sessions/<name>.json` when that file exists. Every child gets `--caps storage`, which saving a session and moving a context to headed Chrome both need. On an explicit close the controller queues `browser_storage_state` behind any running call and keeps the context listed until the save finishes; Playwright MCP writes only inside the workspace, so the export lands in the output dir and the controller moves it into `sessions/` through a temp file and a rename, so concurrent closes never leave a torn file. The `storage` capability also adds cookie, localStorage and sessionStorage tools, which the controller withholds. Both engines create isolated contexts through the same `newContext` call, so sessions work on either; `swarm login` uses Chrome because only its CDP port serves `chrome://inspect`.

## Docs

- [Bot detection and browser engines](docs/bot-detection.md)

## License

MIT
