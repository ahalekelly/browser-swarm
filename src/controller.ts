// The BrowserSwarm controller: one long-lived service that owns both shared
// browsers and every agent's isolated context. Agents reach it through the
// `swarm` CLI over loopback HTTP, so nothing per-agent runs inside an agent
// harness and harnesses have nothing to share between subagents.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CALL_DEADLINE_MS, IDLE_MS, OUTPUT_ROOT, PORT, ROOT, TOKEN_FILE } from './config.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const BOOT_TIMEOUT_MS = 120_000;
const BOOT_POLL_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;
const SWEEP_MS = 15_000;
const DEAD_RETENTION_MS = 3_600_000;
const MAX_BODY_BYTES = 1024 * 1024;
const LARGE_RESULT_LINES = 200;
// browser_run_code_unsafe executes arbitrary JavaScript in the Playwright
// process and is RCE-equivalent; browser_close disposes backend state without
// closing the supplied context, so `swarm <id> close` owns that lifecycle.
// @playwright/mcp only filters tools by capability, and both live in `core`,
// so the controller drops them from discovery and dispatch.
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe', 'browser_close']);

export type BackendName = 'chromium' | 'firefox';

type Backend = {
  name: BackendName;
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
  stop: () => Promise<void>;
};

type Context = {
  id: string;
  backend: BackendName;
  outputDir: string;
  client: Client;
  createdAt: number;
  lastActivity: number;
  inFlight: number;
  queue: Promise<void>;
  dead?: { reason: string; at: number };
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PLATFORM = hostPlatform();
const browsers = new Map<BackendName, BrowserState>();
const contexts = new Map<string, Context>();
let token = '';
let shuttingDown = false;

function hostPlatform(): { chromiumBinary: string; lowPriority: [string, ...string[]] } {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      chromiumBinary: 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium',
      lowPriority: ['taskpolicy', '-c', 'utility'],
    };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { chromiumBinary: 'fingerprint-chromium/chrome', lowPriority: ['nice', '-n', '10'] };
  }
  throw new Error(`unsupported platform ${process.platform} ${process.arch}; BrowserSwarm supports Darwin arm64 and Linux x86_64`);
}

function backendFor(name: BackendName): Backend {
  const firefox = name === 'firefox';
  return {
    name,
    displayName: `shared ${firefox ? 'Firefox' : 'Chromium'} browser`,
    port: firefox ? 9378 : 9377,
    profile: join(ROOT, `${name}-browser-profile`),
    endpoint: firefox ? 'ws://127.0.0.1:9378/browser-swarm' : 'http://127.0.0.1:9377',
    endpointFlag: firefox ? '--endpoint' : '--cdp-endpoint',
  };
}

function browserState(name: BackendName): BrowserState {
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

async function ensureBrowser(name: BackendName): Promise<void> {
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
  if (backend.name === 'chromium') await launchChromium(state);
  else await launchFirefox(state);
  state.running = true;
  state.startedAt = Date.now();
  state.idleSince = Date.now();
  log(`${backend.displayName} up: pid ${state.pid}, ${backend.endpoint}`);
}

async function launchChromium(state: BrowserState): Promise<void> {
  const { backend } = state;
  const binary = join(ROOT, PLATFORM.chromiumBinary);
  const seedFile = join(ROOT, 'fingerprint-seed');
  const seed = readFileSync(seedFile, 'utf8').trim();
  const [command, ...priorityArgs] = PLATFORM.lowPriority;
  const child = spawn(command, [
    ...priorityArgs,
    binary,
    '--headless',
    // Headless Chromium still plays page audio through the speakers.
    '--mute-audio',
    `--fingerprint=${seed}`,
    '--fingerprint-platform=macos',
    '--fingerprint-brand=Chrome',
    `--remote-debugging-port=${backend.port}`,
    `--user-data-dir=${backend.profile}`,
    '--no-first-run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

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
  void exited.then(() => { down = true; onBrowserExit(state); });

  state.pid = child.pid;
  state.stop = async () => {
    state.stopping = true;
    child.kill();
    // Chromium ignores SIGTERM until it finishes starting.
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };

  // A cold first-run profile on a loaded machine takes tens of seconds to open
  // its debugging port, so the wait is generous.
  for (let waited = 0; waited < BOOT_TIMEOUT_MS; waited += BOOT_POLL_MS) {
    if (down) throw new Error(`${backend.displayName} exited during startup. Its last output:\n${tail.trimEnd() || '(none)'}`);
    if (await cdpReady(backend.port)) return;
    await delay(BOOT_POLL_MS);
  }
  await state.stop();
  throw new Error(`${backend.displayName} did not answer on port ${backend.port} within ${BOOT_TIMEOUT_MS / 1000}s. Its last output:\n${tail.trimEnd() || '(none)'}`);
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
  const orphaned = [...contexts.values()].filter((context) => context.backend === state.backend.name && !context.dead);
  if (!state.stopping) {
    state.lastCrash = `${timestamp()} ${state.backend.displayName} exited unexpectedly, losing ${orphaned.length} context${orphaned.length === 1 ? '' : 's'}`;
    log(state.lastCrash);
  }
  for (const context of orphaned) {
    killContext(context, `${state.backend.displayName} exited, so context ${context.id} is lost`);
  }
}

function cdpReady(port: number): Promise<boolean> {
  return new Promise((resolveReady) => {
    const request = get({ host: '127.0.0.1', port, path: '/json/version', agent: false, timeout: 2000 }, (response) => {
      response.resume();
      resolveReady(response.statusCode === 200);
    });
    request.once('error', () => resolveReady(false));
    request.once('timeout', () => {
      request.destroy();
      resolveReady(false);
    });
  });
}

// Contexts

async function openContext(name: BackendName): Promise<{ id: string; outputDir: string }> {
  await ensureBrowser(name);
  const backend = backendFor(name);
  // Output dirs outlive their contexts, so ids must stay unique over the
  // controller's whole history, not just among the live contexts.
  const id = `c${randomBytes(8).toString('hex')}`;
  const outputDir = join(OUTPUT_ROOT, id);
  mkdirSync(outputDir, { recursive: true });

  const client = new Client({ name: 'browser-swarm', version: version() }, { capabilities: {} });
  const context: Context = {
    id,
    backend: name,
    outputDir,
    client,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // Initialization counts as active work so the sweeper cannot reap a
    // context that has not finished opening.
    inFlight: 1,
    queue: Promise.resolve(),
  };
  contexts.set(id, context);
  browserState(name).idleSince = undefined;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(ROOT, 'node_modules/@playwright/mcp/cli.js'),
      backend.endpointFlag, backend.endpoint,
      '--isolated',
      '--output-dir', outputDir,
      // Screenshots come back as a file path the agent reads with its own
      // image-capable tool instead of an inline image the CLI cannot print.
      '--image-responses', 'omit',
    ],
    // Playwright MCP restricts file access to its workspace root, which is the
    // process cwd. Each context therefore works inside its own output dir.
    cwd: outputDir,
    env: environment(),
    stderr: 'inherit',
  });

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    contexts.delete(id);
    await client.close().catch(() => {});
    releaseBrowserIfIdle(name);
    throw new ApiError(500, `could not start a ${name} context: ${message(error)}`);
  }
  // A Playwright MCP child that dies on its own loses the context with it.
  client.onclose = () => killContext(context, `context ${id} is lost: its Playwright MCP process exited`);
  context.inFlight -= 1;
  context.lastActivity = Date.now();
  log(`opened ${id} (${name}) at ${outputDir}`);
  return { id, outputDir };
}

function liveContext(id: string): Context {
  const context = contexts.get(id);
  if (!context) throw new ApiError(404, `unknown context ${id} — it was closed, expired, or belongs to an earlier controller`);
  if (context.dead) throw new ApiError(410, context.dead.reason);
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
  if (BLOCKED_TOOLS.has(name)) throw new ApiError(400, `${name} is not available through BrowserSwarm`);
  const context = liveContext(id);
  const result = await enqueue(context, true, async () => {
    try {
      return await context.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_DEADLINE_MS });
    } catch (error) {
      if (context.dead) throw new ApiError(410, context.dead.reason);
      // A tool that never returns has wedged the child; everything else — an
      // unknown tool, a rejected argument — leaves the context usable.
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        killContext(context, `context ${id} is lost: ${name} did not finish within ${CALL_DEADLINE_MS / 1000}s`);
        throw new ApiError(410, context.dead!.reason);
      }
      throw new ApiError(400, message(error));
    }
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

async function listTools(id: string): Promise<{ tools: unknown[] }> {
  const context = liveContext(id);
  const result = await enqueue(context, true, () => context.client.listTools());
  return { tools: result.tools.filter((tool) => !BLOCKED_TOOLS.has(tool.name)) };
}

function killContext(context: Context, reason: string): void {
  if (context.dead) return;
  context.dead = { reason, at: Date.now() };
  void context.client.close().catch(() => {});
  releaseBrowserIfIdle(context.backend);
}

function closeContext(id: string): boolean {
  const context = contexts.get(id);
  if (!context) return false;
  contexts.delete(id);
  context.client.onclose = undefined;
  if (!context.dead) void context.client.close().catch(() => {});
  releaseBrowserIfIdle(context.backend);
  log(`closed ${id}`);
  return true;
}

function releaseBrowserIfIdle(name: BackendName): void {
  const state = browserState(name);
  const live = [...contexts.values()].some((context) => context.backend === name && !context.dead);
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
    if (context.inFlight === 0 && now - context.lastActivity > IDLE_MS) {
      log(`context ${context.id} idle for ${IDLE_MS / 1000}s`);
      closeContext(context.id);
    }
  }
  for (const state of browsers.values()) {
    if (!state.running || state.idleSince === undefined) continue;
    if (now - state.idleSince <= IDLE_MS) continue;
    log(`${state.backend.displayName} has had no contexts for ${IDLE_MS / 1000}s, stopping it`);
    void state.stop();
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
      contexts: [...contexts.values()].filter((context) => context.backend === state.backend.name && !context.dead).length,
      lastCrash: state.lastCrash ?? null,
    })),
    contexts: [...contexts.values()].filter((context) => !context.dead).length,
  };
}

async function describeContexts(): Promise<{ contexts: unknown[] }> {
  const live = [...contexts.values()].filter((context) => !context.dead);
  const described = await Promise.all(live.map(async (context) => ({
    id: context.id,
    backend: context.backend,
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
    if (backend !== 'chromium' && backend !== 'firefox') throw new ApiError(400, `unknown backend ${JSON.stringify(backend)}`);
    return send(response, 200, await openContext(backend));
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
  if (request.method === 'DELETE' && single) return send(response, 200, { id: single[1], closed: closeContext(single[1]) });

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
  for (const id of [...contexts.keys()]) closeContext(id);
  await Promise.all([...browsers.values()].filter((state) => state.running).map((state) => state.stop()));
  process.exit(0);
}

function start(): void {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const seedFile = join(ROOT, 'fingerprint-seed');
  try {
    readFileSync(seedFile);
  } catch {
    writeFileSync(seedFile, `${randomBytes(4).readUInt32LE() % 100_000_000}\n`);
  }
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
