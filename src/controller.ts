// The BrowserSwarm controller: one long-lived service that owns the shared
// browsers and every agent's isolated context. Agents reach it through the
// `swarm` CLI over loopback HTTP, so nothing per-agent runs inside an agent
// harness and harnesses have nothing to share between subagents.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getDomain } from 'tldts';
import { challengeMarkers, type PageState } from './challenge.ts';
import { CHROME_BINARY, chromeArgs, disableSafeBrowsing, HEADED_SCREEN, headlessUserAgent, VIEWPORT } from './chrome.ts';
import { CALL_DEADLINE_MS, IDLE_MS, OUTPUT_ROOT, PORT, ROOT, SESSION_ROOT, TOKEN_FILE } from './config.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const BOOT_TIMEOUT_MS = 120_000;
const BOOT_POLL_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;
const SWEEP_MS = 15_000;
const DEAD_RETENTION_MS = 3_600_000;
const OUTPUT_RETENTION_MS = 86_400_000;
const MAX_BODY_BYTES = 1024 * 1024;
const LARGE_RESULT_LINES = 200;
// browser_run_code_unsafe executes arbitrary JavaScript in the Playwright
// process and is RCE-equivalent; browser_close disposes backend state without
// closing the supplied context, so `swarm <id> close` owns that lifecycle.
// @playwright/mcp only filters tools by capability, and both live in `core`,
// so the controller drops them from discovery and dispatch.
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe', 'browser_close']);
// Every context runs with the `storage` capability so the controller can
// export its state, to save a session or to move it to headed Chrome. Those
// tools would hand the agent session cookies, including HttpOnly ones, so they
// stay controller-only.
const STORAGE_TOOLS = /^browser_((cookie|localstorage|sessionstorage)_[a-z]+|(set_)?storage_state)$/;
const SESSION_NAME = /^[a-z0-9-]+$/;
const SAVE_DEADLINE_MS = 30_000;
// A challenge page that clears itself (a JavaScript check, a slow SPA) gets
// this long before it counts as a block.
const RECHECK_MS = 5_000;
// The pause between a block on headless Chrome and the retry on headed Chrome,
// so the site does not see two browsers from one IP within moments.
const RETRY_PAUSE_MS = 10_000;
const HEADED_LEASE_MS = 30 * 86_400_000;
const HEADED_SITES_FILE = join(ROOT, 'headed-sites.json');
const PORTS: Record<BrowserName, number> = { chrome: 9377, firefox: 9378, 'chrome-headed': 9379 };
const XVFB = 'Xvfb';
const PAGE_PROBE = `() => ({
  url: location.href,
  status: performance.getEntriesByType('navigation')[0]?.responseStatus ?? null,
  title: document.title,
  body: (document.body?.innerText ?? '').slice(0, 500),
  html: document.contentType === 'text/html',
})`;

// What an agent asks for. On Linux, `chrome` contexts move to the headed
// browser for sites that block headless Chrome.
export type BackendName = 'chrome' | 'firefox';
type BrowserName = 'chrome' | 'chrome-headed' | 'firefox';

type Backend = {
  name: BrowserName;
  displayName: string;
  port: number;
  profile: string;
  endpoint: string;
  endpointFlag: string;
};

type BrowserState = {
  backend: Backend;
  starting?: Promise<void>;
  running: boolean;
  pid?: number;
  startedAt?: number;
  stopping: boolean;
  lastCrash?: string;
  idleSince?: number;
  userAgent?: string;
  stop: () => Promise<void>;
};

type Context = {
  id: string;
  browser: BrowserName;
  outputDir: string;
  session?: string;
  client: Client;
  // The page URL last checked for a challenge.
  checkedUrl?: string;
  createdAt: number;
  lastActivity: number;
  inFlight: number;
  queue: Promise<void>;
  dead?: { reason: string; at: number };
  closing: boolean;
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PLATFORM = hostPlatform();
const browsers = new Map<BrowserName, BrowserState>();
const contexts = new Map<string, Context>();
// Registrable domain to the epoch ms its headed routing expires.
const headedSites = new Map<string, number>();
let token = '';
let shuttingDown = false;

function hostPlatform(): { lowPriority: [string, ...string[]]; headed: boolean } {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { lowPriority: ['taskpolicy', '-c', 'utility'], headed: false };
  if (process.platform === 'linux' && process.arch === 'x64') return { lowPriority: ['nice', '-n', '10'], headed: true };
  throw new Error(`unsupported platform ${process.platform} ${process.arch}; BrowserSwarm supports Darwin arm64 and Linux x86_64`);
}

function backendFor(name: BrowserName): Backend {
  const port = PORTS[name];
  const firefox = name === 'firefox';
  return {
    name,
    displayName: { chrome: 'headless Chrome', 'chrome-headed': 'headed Chrome', firefox: 'Firefox' }[name],
    port,
    profile: join(ROOT, `${name}-browser-profile`),
    endpoint: firefox ? `ws://127.0.0.1:${port}/browser-swarm` : `http://127.0.0.1:${port}`,
    endpointFlag: firefox ? '--endpoint' : '--cdp-endpoint',
  };
}

function browserState(name: BrowserName): BrowserState {
  let state = browsers.get(name);
  if (!state) {
    state = {
      backend: backendFor(name),
      running: false,
      stopping: false,
      idleSince: Date.now(),
      stop: async () => {},
    };
    browsers.set(name, state);
  }
  return state;
}

// Browsers

async function ensureBrowser(name: BrowserName): Promise<void> {
  const state = browserState(name);
  if (state.running) return;
  state.starting ??= launchBrowser(state).finally(() => { state.starting = undefined; });
  await state.starting;
}

async function launchBrowser(state: BrowserState): Promise<void> {
  const { backend } = state;
  mkdirSync(backend.profile, { recursive: true });
  state.stopping = false;
  log(`starting ${backend.displayName}`);
  if (backend.name === 'firefox') await launchFirefox(state);
  else await launchChrome(state, backend.name === 'chrome-headed');
  state.running = true;
  state.startedAt = Date.now();
  state.idleSince = Date.now();
  log(`${backend.displayName} up: pid ${state.pid}, ${backend.endpoint}`);
}

async function launchChrome(state: BrowserState, headed: boolean): Promise<void> {
  const { backend } = state;
  disableSafeBrowsing(backend.profile);
  const display = headed ? await startXvfb() : undefined;
  const { DISPLAY, ...env } = environment();
  const [command, ...priorityArgs] = PLATFORM.lowPriority;
  const child = spawn(command, [...priorityArgs, CHROME_BINARY, ...chromeArgs(headed, backend.port, backend.profile)], {
    env: display ? { ...env, DISPLAY: display.name } : env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Browser output goes to the controller's log, and its tail goes into the
  // startup error, because that error is all an agent ever sees.
  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-2000);
      process.stderr.write(chunk);
    });
  }

  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
  let down = false;
  void exited.then(async () => {
    down = true;
    await display?.stop();
    onBrowserExit(state);
  });
  // Chrome cannot outlive its display.
  display?.onExit(() => child.kill());

  state.pid = child.pid;
  state.stop = async () => {
    state.stopping = true;
    child.kill();
    // Chrome ignores SIGTERM until it finishes starting.
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };

  // A cold first-run profile on a loaded machine takes tens of seconds to open
  // its debugging port, so the wait is generous.
  for (let waited = 0; waited < BOOT_TIMEOUT_MS; waited += BOOT_POLL_MS) {
    if (down) throw new Error(`${backend.displayName} exited during startup. Its last output:\n${tail.trimEnd() || '(none)'}`);
    const version = await cdpVersion(backend.port);
    if (version) {
      if (!headed) state.userAgent = headlessUserAgent(version['User-Agent']);
      return;
    }
    await delay(BOOT_POLL_MS);
  }
  await state.stop();
  throw new Error(`${backend.displayName} did not answer on port ${backend.port} within ${BOOT_TIMEOUT_MS / 1000}s. Its last output:\n${tail.trimEnd() || '(none)'}`);
}

// Xvfb picks a free display itself and reports it on the -displayfd pipe.
async function startXvfb(): Promise<{ name: string; stop: () => Promise<void>; onExit: (listener: () => void) => void }> {
  const [command, ...priorityArgs] = PLATFORM.lowPriority;
  const child = spawn(command, [...priorityArgs, XVFB, '-displayfd', '3', '-screen', '0', `${HEADED_SCREEN.width}x${HEADED_SCREEN.height}x24`, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { output = (output + chunk).slice(-2000); });
  const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
  const display = await new Promise<string>((resolveDisplay, rejectDisplay) => {
    let reported = '';
    const pipe = child.stdio[3] as NodeJS.ReadableStream;
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk: string) => {
      reported += chunk;
      if (reported.includes('\n')) resolveDisplay(`:${reported.trim()}`);
    });
    child.once('error', (error) => rejectDisplay(new Error(`could not run ${XVFB} for headed Chrome: ${error.message}`)));
    void exited.then(() => rejectDisplay(new Error(`${XVFB} exited before reporting a display. Its last output:\n${output.trimEnd() || '(none)'}`)));
  });
  return {
    name: display,
    stop: async () => {
      child.kill();
      await exited;
    },
    onExit: (listener) => { void exited.then(listener); },
  };
}

async function launchFirefox(state: BrowserState): Promise<void> {
  const { backend } = state;
  const { firefox } = await import('playwright-core');
  const server = await firefox.launchServer({
    headless: true,
    // Headless Firefox still plays page audio through the speakers.
    firefoxUserPrefs: { 'media.volume_scale': '0.0' },
    host: '127.0.0.1',
    port: backend.port,
    wsPath: '/browser-swarm',
  });
  if (server.wsEndpoint() !== backend.endpoint) {
    await server.close();
    throw new Error(`Firefox endpoint mismatch: expected ${backend.endpoint}, got ${server.wsEndpoint()}`);
  }
  state.pid = server.process().pid;
  state.stop = async () => {
    state.stopping = true;
    await server.close();
  };
  server.on('close', () => onBrowserExit(state));
}

function onBrowserExit(state: BrowserState): void {
  if (!state.running && !state.starting) return;
  state.running = false;
  state.pid = undefined;
  const orphaned = [...contexts.values()].filter((context) => context.browser === state.backend.name && !context.dead);
  if (!state.stopping) {
    state.lastCrash = `${timestamp()} ${state.backend.displayName} exited unexpectedly, losing ${orphaned.length} context${orphaned.length === 1 ? '' : 's'}`;
    log(state.lastCrash);
  }
  for (const context of orphaned) {
    killContext(context, `${state.backend.displayName} exited, so context ${context.id} is lost`);
  }
}

function cdpVersion(port: number): Promise<Record<string, string> | undefined> {
  return new Promise((resolveVersion) => {
    const request = get({ host: '127.0.0.1', port, path: '/json/version', agent: false, timeout: 2000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolveVersion(response.statusCode === 200 ? JSON.parse(text) : undefined));
    });
    request.once('error', () => resolveVersion(undefined));
    request.once('timeout', () => {
      request.destroy();
      resolveVersion(undefined);
    });
  });
}

// Contexts

async function openContext(backend: BackendName, session?: string): Promise<{ id: string; outputDir: string; session?: { name: string; existing: boolean } }> {
  const browser: BrowserName = backend;
  await ensureBrowser(browser);
  // Output dirs outlive their contexts, so ids must stay unique over the
  // controller's whole history, not just among the live contexts.
  const id = `c${randomBytes(8).toString('hex')}`;
  const outputDir = join(OUTPUT_ROOT, id);
  // A context's screenshots and exported state are as private as its
  // cookies, and every context's owner runs as this user anyway.
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const existing = session !== undefined && existsSync(sessionFile(session));

  const context: Context = {
    id,
    browser,
    outputDir,
    session,
    client: undefined as unknown as Client,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // Initialization counts as active work so the sweeper cannot reap a
    // context that has not finished opening.
    inFlight: 1,
    queue: Promise.resolve(),
    closing: false,
  };
  contexts.set(id, context);
  browserState(browser).idleSince = undefined;
  try {
    context.client = await startChild(context, existing ? sessionFile(session!) : undefined);
  } catch (error) {
    contexts.delete(id);
    releaseBrowserIfIdle(browser);
    throw new ApiError(500, `could not start a ${backend} context: ${message(error)}`);
  }
  context.inFlight -= 1;
  context.lastActivity = Date.now();
  log(`opened ${id} (${browser}${session === undefined ? '' : `, session ${session}`}) at ${outputDir}`);
  return { id, outputDir, ...(session === undefined ? {} : { session: { name: session, existing } }) };
}

// One Playwright MCP process attached to the context's current browser.
async function startChild(context: Context, storageState: string | undefined): Promise<Client> {
  const backend = backendFor(context.browser);
  const { userAgent } = browserState(context.browser);
  const client = new Client({ name: 'browser-swarm', version: version() }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.argv0,
    args: [
      join(ROOT, 'node_modules/@playwright/mcp/cli.js'),
      backend.endpointFlag, backend.endpoint,
      '--isolated',
      '--output-dir', context.outputDir,
      // Screenshots come back as a file path the agent reads with its own
      // image-capable tool instead of an inline image the CLI cannot print.
      '--image-responses', 'omit',
      '--caps', 'storage',
      ...(storageState === undefined ? [] : ['--storage-state', storageState]),
      ...(context.browser === 'firefox' ? [] : ['--viewport-size', VIEWPORT]),
      ...(userAgent === undefined ? [] : ['--user-agent', userAgent]),
    ],
    // Playwright MCP restricts file access to its workspace root, which is the
    // process cwd. Each context therefore works inside its own output dir.
    cwd: context.outputDir,
    env: environment(),
    stderr: 'inherit',
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  // A Playwright MCP child that dies on its own loses the context with it.
  client.onclose = () => killContext(context, `context ${context.id} is lost: its Playwright MCP process exited`);
  return client;
}

// Moves a context to another browser, carrying its cookies and storage. Its
// tabs close; a move happens only at a navigation, which replaces the page
// and its element refs anyway.
async function moveContext(context: Context, target: BrowserName): Promise<void> {
  await ensureBrowser(target);
  const exported = join(context.outputDir, `.move-${Date.now().toString(36)}.json`);
  await exportState(context, exported);
  const previous = context.browser;
  context.client.onclose = undefined;
  void context.client.close().catch(() => {});
  context.browser = target;
  context.checkedUrl = undefined;
  browserState(target).idleSince = undefined;
  releaseBrowserIfIdle(previous);
  try {
    context.client = await startChild(context, exported);
    // Playwright MCP reads the storage state when its first tool call
    // creates the browser context.
    await context.client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }, undefined, { timeout: CALL_DEADLINE_MS });
  } catch (error) {
    killContext(context, `context ${context.id} is lost: it could not move to ${backendFor(target).displayName}: ${message(error)}`);
    throw new ApiError(410, context.dead!.reason);
  } finally {
    rmSync(exported, { force: true });
  }
  log(`moved ${context.id} to ${target}`);
}

async function exportState(context: Context, file: string): Promise<void> {
  const result = await context.client.callTool(
    { name: 'browser_storage_state', arguments: { filename: file } },
    undefined,
    { timeout: SAVE_DEADLINE_MS },
  );
  if (result.isError) throw new Error(`browser_storage_state failed: ${JSON.stringify(result.content)}`);
}

function sessionFile(session: string): string {
  return join(SESSION_ROOT, `${session}.json`);
}

// Playwright MCP writes the export inside the context's workspace, which is
// all it may write to; the controller moves it into the session store. The
// temp-then-rename write means concurrent closes of one session leave the last
// complete state rather than a torn file.
async function saveSession(context: Context, session: string): Promise<void> {
  const exported = join(context.outputDir, 'session-state.json');
  await enqueue(context, false, () => exportState(context, exported));
  const temporary = join(SESSION_ROOT, `.${session}.${context.id}.tmp`);
  try {
    writeFileSync(temporary, readFileSync(exported), { mode: 0o600 });
    renameSync(temporary, sessionFile(session));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  unlinkSync(exported);
}

function liveContext(id: string): Context {
  const context = contexts.get(id);
  if (!context) throw new ApiError(404, `unknown context ${id} — it was closed, expired, or belongs to an earlier controller`);
  if (context.dead) throw new ApiError(410, context.dead.reason);
  if (context.closing) throw new ApiError(410, `context ${id} is closing`);
  return context;
}

// Playwright MCP mutates selected-tab and running-tool state per call, so calls
// to one context run one at a time; different contexts run concurrently.
async function enqueue<T>(context: Context, renewLease: boolean, task: () => Promise<T>): Promise<T> {
  context.inFlight += 1;
  const previous = context.queue;
  let release = () => {};
  context.queue = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  await previous;
  try {
    if (context.dead) throw new ApiError(410, context.dead.reason);
    return await task();
  } finally {
    context.inFlight -= 1;
    if (renewLease) context.lastActivity = Date.now();
    release();
  }
}

async function callTool(id: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; outputDir: string; savedPath?: string }> {
  if (name === 'browser_close') {
    throw new ApiError(400, `browser_close is not available through BrowserSwarm; close the context with \`swarm ${id} close\``);
  }
  if (withheld(name)) throw new ApiError(400, `${name} is not available through BrowserSwarm`);
  const context = liveContext(id);
  const result = await enqueue(context, true, async () => {
    const navigation = name === 'browser_navigate' && typeof args.url === 'string' ? args.url : undefined;
    if (navigation !== undefined && context.browser === 'chrome' && needsHeaded(navigation)) await moveContext(context, 'chrome-headed');
    const first = await invoke(context, name, args);
    if (!PLATFORM.headed || context.browser !== 'chrome' || first.isError) return first;
    const retry = await blockedUrl(context, first, navigation);
    if (retry === undefined) return first;
    await delay(RETRY_PAUSE_MS);
    await moveContext(context, 'chrome-headed');
    return await invoke(context, 'browser_navigate', { url: retry });
  });

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item: { type: string; text?: string }) => (item.type === 'text' ? item.text ?? '' : `[${item.type} content]`))
    .join('\n');
  const lines = text.split('\n').length;
  if (lines <= LARGE_RESULT_LINES) return { text, isError: result.isError === true, outputDir: context.outputDir };
  const savedPath = join(context.outputDir, `result-${Date.now().toString(36)}.txt`);
  writeFileSync(savedPath, text);
  return { text, isError: result.isError === true, outputDir: context.outputDir, savedPath };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

async function invoke(context: Context, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await context.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_DEADLINE_MS });
  } catch (error) {
    if (context.dead) throw new ApiError(410, context.dead.reason);
    // A tool that never returns has wedged the child; everything else — an
    // unknown tool, a rejected argument — leaves the context usable.
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      killContext(context, `context ${context.id} is lost: ${name} did not finish within ${CALL_DEADLINE_MS / 1000}s`);
      throw new ApiError(410, context.dead!.reason);
    }
    throw new ApiError(400, message(error));
  }
}

// When a call lands headless Chrome on a new page that stays a bot challenge,
// learns the site as needing headed Chrome and returns the URL to retry there.
async function blockedUrl(context: Context, result: ToolResult, navigation: string | undefined): Promise<string | undefined> {
  const text = (result.content as { text?: string }[]).map((item) => item.text ?? '').join('\n');
  const pageUrl = text.match(/^- Page URL: (\S+)$/m)?.[1];
  if (pageUrl === undefined || (navigation === undefined && pageUrl === context.checkedUrl)) return undefined;
  context.checkedUrl = pageUrl;
  const requested = navigation ?? pageUrl;
  const domain = getDomain(requested);
  if (domain === null) return undefined;
  for (const wait of [0, RECHECK_MS]) {
    await delay(wait);
    const page = await probePage(context);
    if (page === undefined) return undefined;
    const markers = challengeMarkers(page, requested);
    if (markers.length === 0) return undefined;
    if (wait === RECHECK_MS) log(`${context.id}: ${page.url} challenged headless Chrome (${markers.join(', ')})`);
  }
  headedSites.set(domain, Date.now() + HEADED_LEASE_MS);
  saveHeadedSites();
  log(`${domain} now opens in headed Chrome`);
  return requested;
}

// A page mid-navigation cannot be read; that counts as no verdict.
async function probePage(context: Context): Promise<PageState | undefined> {
  const result = await invoke(context, 'browser_evaluate', { function: PAGE_PROBE });
  const text = (result.content as { text?: string }[]).map((item) => item.text ?? '').join('\n');
  const json = text.match(/^### Result\n([\s\S]*?)\n### /m)?.[1];
  return result.isError || json === undefined ? undefined : JSON.parse(json);
}

function needsHeaded(url: string): boolean {
  const domain = getDomain(url);
  return domain !== null && (headedSites.get(domain) ?? 0) > Date.now();
}

function loadHeadedSites(): void {
  if (!existsSync(HEADED_SITES_FILE)) return;
  for (const [domain, until] of Object.entries(JSON.parse(readFileSync(HEADED_SITES_FILE, 'utf8')) as Record<string, string>)) {
    headedSites.set(domain, Date.parse(until));
  }
}

function saveHeadedSites(): void {
  const now = Date.now();
  for (const [domain, until] of headedSites) if (until <= now) headedSites.delete(domain);
  const entries = Object.fromEntries([...headedSites].map(([domain, until]) => [domain, new Date(until).toISOString()]));
  const temporary = `${HEADED_SITES_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(temporary, HEADED_SITES_FILE);
}

async function listTools(id: string): Promise<{ tools: unknown[] }> {
  const context = liveContext(id);
  const result = await enqueue(context, true, () => context.client.listTools());
  return { tools: result.tools.filter((tool) => !withheld(tool.name)) };
}

function withheld(name: string): boolean {
  return BLOCKED_TOOLS.has(name) || STORAGE_TOOLS.test(name);
}

function killContext(context: Context, reason: string): void {
  if (context.dead) return;
  context.dead = { reason, at: Date.now() };
  void context.client.close().catch(() => {});
  releaseBrowserIfIdle(context.browser);
}

// An explicit close saves a session context's state, after any call still in
// its queue; expiry and shutdown discard it, so an abandoned context (an
// aborted login, say) never overwrites the saved session. The context stays
// listed while it saves, so `ls` and `swarm login` see it until the file is final.
// A dead context has no browser state left to save.
async function closeContext(id: string, save: boolean): Promise<{ closed: boolean; session?: string }> {
  const context = contexts.get(id);
  if (!context || context.closing) return { closed: false };
  context.closing = true;
  context.client.onclose = undefined;
  const { session } = context;
  try {
    if (session === undefined || !save) return { closed: true };
    if (context.dead) throw new Error(context.dead.reason);
    await saveSession(context, session);
    log(`saved session ${session}`);
    return { closed: true, session };
  } catch (error) {
    throw new ApiError(500, `closed ${id}, but session ${session} was not saved: ${message(error)}`);
  } finally {
    contexts.delete(id);
    if (!context.dead) void context.client.close().catch(() => {});
    releaseBrowserIfIdle(context.browser);
    log(`closed ${id}`);
  }
}

function releaseBrowserIfIdle(name: BrowserName): void {
  const state = browserState(name);
  const live = [...contexts.values()].some((context) => context.browser === name && !context.dead);
  state.idleSince = live ? undefined : Date.now();
}

// A context's lease renews when a call finishes. In-flight work suspends
// expiry, so a long navigation never loses its context, and a client that
// disconnects mid-call does not make that work look idle.
function sweep(): void {
  const now = Date.now();
  for (const context of contexts.values()) {
    if (context.dead) {
      if (now - context.dead.at > DEAD_RETENTION_MS) contexts.delete(context.id);
      continue;
    }
    if (!context.closing && context.inFlight === 0 && now - context.lastActivity > IDLE_MS) {
      log(`context ${context.id} idle for ${IDLE_MS / 1000}s`);
      void closeContext(context.id, false);
    }
  }
  for (const state of browsers.values()) {
    if (!state.running || state.idleSince === undefined) continue;
    if (now - state.idleSince <= IDLE_MS) continue;
    log(`${state.backend.displayName} has had no contexts for ${IDLE_MS / 1000}s, stopping it`);
    void state.stop();
  }
  for (const id of readdirSync(OUTPUT_ROOT)) {
    const dir = join(OUTPUT_ROOT, id);
    if (!contexts.has(id) && now - statSync(dir).mtimeMs > OUTPUT_RETENTION_MS) rmSync(dir, { recursive: true, force: true });
  }
}

// HTTP API

function snapshot(): Record<string, unknown> {
  return {
    port: PORT,
    browsers: [...browsers.values()].map((state) => ({
      backend: state.backend.name,
      running: state.running,
      pid: state.pid ?? null,
      upSeconds: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : null,
      contexts: [...contexts.values()].filter((context) => context.browser === state.backend.name && !context.dead).length,
      lastCrash: state.lastCrash ?? null,
    })),
    contexts: [...contexts.values()].filter((context) => !context.dead).length,
    headedSites: [...headedSites]
      .filter(([, until]) => until > Date.now())
      .map(([domain, until]) => ({ domain, until: new Date(until).toISOString() })),
  };
}

async function describeContexts(): Promise<{ contexts: unknown[] }> {
  const live = [...contexts.values()].filter((context) => !context.dead);
  const described = await Promise.all(live.map(async (context) => ({
    id: context.id,
    browser: context.browser,
    port: backendFor(context.browser).port,
    session: context.session ?? null,
    ageSeconds: Math.round((Date.now() - context.createdAt) / 1000),
    idleSeconds: Math.round((Date.now() - context.lastActivity) / 1000),
    busy: context.inFlight > 0,
    outputDir: context.outputDir,
    pages: context.inFlight > 0 ? null : await pageUrls(context),
  })));
  return { contexts: described };
}

// `ls` must not keep a context alive, so this listing call skips the lease
// renewal every agent-driven call gets.
async function pageUrls(context: Context): Promise<string[]> {
  const result = await enqueue(context, false, () => context.client.callTool(
    { name: 'browser_tabs', arguments: { action: 'list' } },
    undefined,
    { timeout: 10_000 },
  )).catch(() => undefined);
  if (!result || !Array.isArray(result.content)) return [];
  const text = result.content.map((item: { text?: string }) => item.text ?? '').join('\n');
  return [...text.matchAll(/\((\w+:\/\/\S+?)\)/g)].map((match) => match[1]);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Loopback binding is not a security boundary: any page the swarm browser
  // loads can reach this port. The bearer token and the Host check are.
  if (request.headers.host !== `127.0.0.1:${PORT}`) throw new ApiError(400, 'unexpected Host header');
  const presented = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!sameToken(presented)) throw new ApiError(401, 'missing or invalid controller token');

  const url = request.url ?? '/';
  if (request.method === 'GET' && url === '/status') return send(response, 200, snapshot());
  if (request.method === 'GET' && url === '/contexts') return send(response, 200, await describeContexts());

  if (request.method === 'POST' && url === '/contexts') {
    const body = await readBody(request);
    const backend = body.backend;
    if (backend !== 'chrome' && backend !== 'firefox') throw new ApiError(400, `unknown backend ${JSON.stringify(backend)}`);
    const { session } = body;
    if (session !== undefined && (typeof session !== 'string' || !SESSION_NAME.test(session))) {
      throw new ApiError(400, `session names use only a-z, 0-9 and -, got ${JSON.stringify(session)}`);
    }
    return send(response, 200, await openContext(backend, session));
  }

  const call = url.match(/^\/contexts\/(c[0-9a-f]{16})\/call$/);
  if (request.method === 'POST' && call) {
    const body = await readBody(request);
    if (typeof body.name !== 'string') throw new ApiError(400, 'call needs a tool name');
    const args = body.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ApiError(400, 'call arguments must be a JSON object');
    return send(response, 200, await callTool(call[1], body.name, args as Record<string, unknown>));
  }

  const tools = url.match(/^\/contexts\/(c[0-9a-f]{16})\/tools$/);
  if (request.method === 'POST' && tools) return send(response, 200, await listTools(tools[1]));

  const single = url.match(/^\/contexts\/(c[0-9a-f]{16})$/);
  if (request.method === 'DELETE' && single) return send(response, 200, { id: single[1], ...await closeContext(single[1], true) });

  throw new ApiError(404, `no route for ${request.method} ${url}`);
}

function sameToken(presented: string): boolean {
  const expected = Buffer.from(token);
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new ApiError(400, 'expected content-type application/json');
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new ApiError(413, `request body over ${MAX_BODY_BYTES} bytes`));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return rejectBody(new ApiError(400, 'body is not valid JSON'));
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return rejectBody(new ApiError(400, 'body must be a JSON object'));
      }
      resolveBody(parsed);
    });
    request.on('error', rejectBody);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

// Startup

function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
}

function version(): string {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Local time, because `swarm status` prints the last crash next to a wall
// clock. sv-SE is the locale whose short format is already ISO-shaped.
function timestamp(): string {
  return new Date().toLocaleString('sv-SE');
}

function log(line: string): void {
  console.error(`${timestamp()} ${line}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  for (const id of [...contexts.keys()]) void closeContext(id, false);
  await Promise.all([...browsers.values()].filter((state) => state.running).map((state) => state.stop()));
  process.exit(0);
}

function start(): void {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  mkdirSync(SESSION_ROOT, { recursive: true, mode: 0o700 });
  chmodSync(SESSION_ROOT, 0o700);
  loadHeadedSites();
  // A fresh token per controller start invalidates every stale handle at once.
  token = randomBytes(24).toString('hex');

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      const status = error instanceof ApiError ? error.status : 500;
      if (!response.headersSent) send(response, status, { error: message(error) });
      if (status === 500) log(`error: ${error instanceof Error ? error.stack : String(error)}`);
    });
  });
  // The token file lands only once the API answers, so its presence is what
  // tells a client the controller is ready.
  server.listen(PORT, '127.0.0.1', () => {
    writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
    log(`controller listening on 127.0.0.1:${PORT}`);
  });
  setInterval(sweep, SWEEP_MS).unref();
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

start();
