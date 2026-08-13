import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_PATH = fileURLToPath(import.meta.url);
const IDLE_POLL_MS = 30_000;
const IDLE_POLLS = 10;
const FIREFOX_ENDPOINT = 'ws://127.0.0.1:9378/browser-swarm';

export type BrowserName = 'chromium' | 'firefox';

export type Backend = {
  browserName: BrowserName;
  displayName: string;
  protocolName: string;
  port: number;
  profile: string;
  log: string;
  stateFile: string;
  clientEndpoint: string;
};

export class DaemonError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function getBackend(browserName: BrowserName): Backend {
  const firefox = browserName === 'firefox';
  const port = firefox ? 9378 : 9377;
  return {
    browserName,
    displayName: `shared ${firefox ? 'Firefox' : 'Chromium'} browser`,
    protocolName: firefox ? 'Firefox WebSocket server' : 'CDP browser',
    port,
    profile: join(ROOT, `${browserName}-browser-profile`),
    log: join(ROOT, `${browserName}-browser.log`),
    stateFile: join(ROOT, `${browserName}-daemon-state`),
    clientEndpoint: firefox ? FIREFOX_ENDPOINT : `http://localhost:${port}`,
  };
}

export async function ensure(browserName: BrowserName): Promise<void> {
  const backend = getBackend(browserName);
  if (!(await ready(backend)) && ownerPid(backend) === undefined && crashed(backend)) {
    await start(backend);
    throw new DaemonError(`${backend.displayName} crashed since its last clean shutdown (see ${backend.log}) — it has been restarted, but this agent's MCP is deliberately failed so the crash gets reported. Relaunch the agent to attach normally.`);
  }
  await start(backend);
}

export function firefoxEndpoint(): string {
  return FIREFOX_ENDPOINT;
}

async function start(backend: Backend): Promise<void> {
  if (await ready(backend)) return useRunningDaemon(backend, true);

  const startingOwner = ownerPid(backend);
  if (startingOwner !== undefined) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await ready(backend)) return useRunningDaemon(backend, true);
      await delay(500);
    }
    throw new DaemonError(`${backend.displayName} owns port ${backend.port} but did not become ready within 10s; last log lines:\n${lastLogLines(backend.log)}`);
  }

  if (hasListener(backend.port)) {
    if (backend.browserName === 'chromium') {
      throw new DaemonError(`port ${backend.port} is taken by a non-CDP process:\n${listenerDetails(backend.port)}`);
    }
    throw new DaemonError(`a foreign process is serving port ${backend.port} — refusing to share it (see: lsof -i :${backend.port})`);
  }

  if (!canWrite(backend)) {
    throw new DaemonError(`this shell cannot write to ${ROOT} (sandboxed?) — start the daemon from an unsandboxed shell, or let an agent's MCP launcher start it`);
  }

  await prepareBackend(backend);
  if (crashed(backend)) console.error(`warning: previous ${backend.displayName} instance shut down uncleanly (crashed or killed) — see ${backend.log}`);
  spawnDetached(backend.log, process.execPath, [DAEMON_PATH, 'serve', backend.browserName]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await ready(backend) && markerIsRunning(backend)) return useRunningDaemon(backend, false);
    await delay(500);
  }

  throw new DaemonError(`${backend.displayName} did not answer on port ${backend.port} within 10s; last log lines:\n${lastLogLines(backend.log)}`);
}

function useRunningDaemon(backend: Backend, alreadyUp: boolean): void {
  const owner = ownerPid(backend);
  if (owner === undefined) {
    throw new DaemonError(`a foreign ${backend.protocolName} is serving port ${backend.port} — refusing to share it (see: lsof -i :${backend.port})`);
  }
  console.error(`${backend.displayName} ${alreadyUp ? 'already up' : 'up'}: pid ${owner}, ${connectionLabel(backend)}`);
}

async function prepareBackend(backend: Backend): Promise<void> {
  mkdirSync(backend.profile, { recursive: true });
  if (backend.browserName === 'firefox') {
    const { firefox } = await import('playwright-core');
    if (!isExecutable(firefox.executablePath())) {
      throw new DaemonError(`Playwright Firefox is not installed (run ${join(ROOT, 'install-playwright-firefox.sh')})`);
    }
    return;
  }

  const binary = chromiumBinary();
  if (!isExecutable(binary)) {
    throw new DaemonError(`fingerprint-chromium is not installed (run ${join(ROOT, 'install-fingerprint-chromium.sh')})`);
  }
  const seedFile = join(ROOT, 'fingerprint-seed');
  if (!existsSync(seedFile) || readFileSync(seedFile).length === 0) {
    writeFileSync(seedFile, `${randomBytes(4).readUInt32LE() % 100_000_000}\n`);
  }
}

async function serve(backend: Backend): Promise<void> {
  mkdirSync(backend.profile, { recursive: true });
  let child: ChildProcess | undefined;
  let server;
  let closed: Promise<void>;
  let shuttingDown = false;

  if (backend.browserName === 'chromium') {
    const fingerprint = readFileSync(join(ROOT, 'fingerprint-seed'), 'utf8').trim();
    child = spawn('taskpolicy', [
      '-c', 'utility', chromiumBinary(),
      '--headless',
      `--fingerprint=${fingerprint}`,
      '--fingerprint-platform=macos',
      '--fingerprint-brand=Chrome',
      `--remote-debugging-port=${backend.port}`,
      `--user-data-dir=${backend.profile}`,
      '--no-first-run',
    ], { stdio: 'inherit' });
    closed = new Promise((resolveClose) => child.once('close', () => resolveClose()));
  } else {
    // launchServer uses a temporary browser profile. This open file makes the
    // listener owner identifiable through lsof without inspecting processes.
    openSync(join(backend.profile, 'daemon-lock'), 'w');
    const { firefox } = await import('playwright-core');
    server = await firefox.launchServer({
      headless: true,
      host: '127.0.0.1',
      port: backend.port,
      wsPath: '/browser-swarm',
    });
    closed = new Promise((resolveClose) => server.on('close', resolveClose));
    if (server.wsEndpoint() !== backend.clientEndpoint) {
      await server.close();
      throw new Error(`Firefox endpoint mismatch: expected ${backend.clientEndpoint}, got ${server.wsEndpoint()}`);
    }
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } else {
      await server.close();
    }
  };
  const exitOnSignal = () => { void shutdown().then(() => process.exit()); };
  process.once('SIGINT', exitOnSignal);
  process.once('SIGTERM', exitOnSignal);

  const expectedOwner = child?.pid ?? process.pid;
  let listenerPid: number | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (shuttingDown) return;
    if (await Promise.race([closed.then(() => true), delay(0).then(() => false)])) return;
    if (await ready(backend)) {
      listenerPid = ownerPid(backend);
      if (listenerPid === expectedOwner) break;
      if (listenerPid !== undefined) {
        await shutdown();
        throw new Error(`${backend.displayName} lost its startup race to pid ${listenerPid}`);
      }
    }
    await delay(500);
  }
  if (listenerPid !== expectedOwner) {
    await shutdown();
    throw new Error(`${backend.displayName} did not establish ownership of port ${backend.port} within 10s`);
  }

  markRunning(backend);
  console.error(`${timestamp()} serve: watching ${backend.browserName} listener pid ${listenerPid}`);
  let idlePolls = 0;
  for (;;) {
    const event = await Promise.race([closed.then(() => 'closed'), delay(IDLE_POLL_MS).then(() => 'poll')]);
    if (event === 'closed' || shuttingDown) return;
    if (ownerPid(backend) !== listenerPid) {
      await shutdown();
      return;
    }
    idlePolls = clientCount(backend, listenerPid) === 0 ? idlePolls + 1 : 0;
    if (idlePolls < IDLE_POLLS) continue;
    console.error(`${timestamp()} serve: no attached clients for ${(IDLE_POLL_MS * IDLE_POLLS) / 1000}s, stopping ${backend.browserName} listener pid ${listenerPid}`);
    markClean(backend);
    await shutdown();
    return;
  }
}

async function stop(backend: Backend, force: boolean): Promise<void> {
  const owner = ownerPid(backend);
  if (owner === undefined) {
    if (await ready(backend) || hasListener(backend.port)) {
      throw new DaemonError(`the ${backend.protocolName} on port ${backend.port} is not ours — refusing to kill it (see: lsof -i :${backend.port})`);
    }
    if (crashed(backend) && canWrite(backend)) {
      console.error('note: previous instance shut down uncleanly — clearing crash state');
      markClean(backend);
    }
    console.error(`${backend.displayName} already stopped`);
    return;
  }

  const clients = clientCount(backend, owner);
  if (clients > 0 && !force) {
    throw new DaemonError(`${clients} attached client${clients === 1 ? '' : 's'} — refusing to stop the machine-wide ${backend.displayName} (it stops itself after ${(IDLE_POLL_MS * IDLE_POLLS) / 1000}s with no clients; pass --force to override)`);
  }
  if (!canWrite(backend)) {
    throw new DaemonError(`this shell cannot write to ${ROOT} (sandboxed?) — run \`swarm stop ${backend.browserName}\` from an unsandboxed shell`);
  }

  markClean(backend);
  process.kill(owner);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processExists(owner)) {
      console.error(`${backend.displayName} stopped`);
      return;
    }
    await delay(500);
  }
  throw new DaemonError(`pid ${owner} still alive after 10s`);
}

async function status(backend: Backend): Promise<number> {
  const owner = ownerPid(backend);
  if (owner === undefined) {
    if (await ready(backend) || hasListener(backend.port)) {
      console.error(`foreign ${backend.protocolName} on port ${backend.port} (not started by BrowserSwarm):\n${listenerDetails(backend.port)}`);
    } else {
      console.error(`not running (port ${backend.port} closed)`);
      if (crashed(backend)) console.error(`last shutdown: unclean — daemon crashed or was killed (the next agent attach restarts it and reports the crash; \`swarm start ${backend.browserName}\` clears the state now)`);
    }
    return 1;
  }

  console.error(`pid: ${owner}`);
  console.error(`attached clients: ${clientCount(backend, owner)}`);
  if (backend.browserName === 'firefox') {
    console.error(`endpoint: ${backend.clientEndpoint}`);
    return 0;
  }

  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(backend.clientEndpoint, { timeout: 5000 });
  const contexts = browser.contexts();
  console.error(`contexts: ${contexts.length}`);
  for (const context of contexts) console.error(`  pages: ${context.pages().map((page) => page.url()).join(', ') || '(none)'}`);
  await browser.close();
  return 0;
}

async function ready(backend: Backend): Promise<boolean> {
  if (backend.browserName === 'firefox') return portOpen(backend.port);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${backend.port}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection(port, '127.0.0.1');
    const finish = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(2000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function connectionLabel(backend: Backend): string {
  return backend.browserName === 'chromium'
    ? `CDP ${backend.clientEndpoint}`
    : `WebSocket ${backend.clientEndpoint}`;
}

// The listener is ours when it holds a file inside our profile dir open. Use
// lsof's file tables because agent sandboxes commonly block ps but allow lsof.
function ownerPid(backend: Backend): number | undefined {
  for (const pid of listenerPids(backend.port)) {
    const result = spawnSync('lsof', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status === 0 && result.stdout.includes(`${backend.profile}/`)) return pid;
  }
}

function canWrite(backend: Backend): boolean {
  try {
    closeSync(openSync(backend.stateFile, 'a'));
    return true;
  } catch {
    return false;
  }
}

function clientCount(backend: Backend, owner: number): number {
  const result = spawnSync('lsof', ['-t', '-i', `:${backend.port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
  const pids = new Set(result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : []);
  pids.delete(owner);
  return pids.size;
}

function listenerPids(port: number): number[] {
  const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
}

function hasListener(port: number): boolean {
  return listenerPids(port).length > 0;
}

function listenerDetails(port: number): string {
  const result = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return result.stdout.trim();
}

function bootEpoch(): string {
  const output = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
  const match = output.match(/sec = (\d+),/);
  if (!match) throw new Error(`could not parse boot epoch: ${output.trim()}`);
  return match[1];
}

function markRunning(backend: Backend): void {
  writeFileSync(backend.stateFile, `running ${bootEpoch()}\n`);
}

function markClean(backend: Backend): void {
  writeFileSync(backend.stateFile, 'clean\n');
}

function markerIsRunning(backend: Backend): boolean {
  return existsSync(backend.stateFile) && readFileSync(backend.stateFile, 'utf8').startsWith('running ');
}

function crashed(backend: Backend): boolean {
  if (!existsSync(backend.stateFile)) return false;
  const [state, boot] = readFileSync(backend.stateFile, 'utf8').trim().split(/\s+/);
  return state === 'running' && boot === bootEpoch();
}

function chromiumBinary(): string {
  return join(ROOT, 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium');
}

function spawnDetached(logPath: string, command: string, args: string[]): void {
  const log = openSync(logPath, 'a');
  spawn(command, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  closeSync(log);
}

function isExecutable(path: string): boolean {
  return spawnSync('test', ['-x', path]).status === 0;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function lastLogLines(path: string): string {
  if (!existsSync(path)) return '(log is empty)';
  return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-5).join('\n');
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main(): Promise<void> {
  const rest = process.argv.slice(2);
  const force = rest.includes('--force');
  const [verb, browser = 'chromium'] = rest.filter((arg) => arg !== '--force');
  if (force && verb !== 'stop') throw new DaemonError('--force only applies to stop', 2);
  if (browser !== 'chromium' && browser !== 'firefox') throw new DaemonError(`unknown browser: ${browser}`, 2);
  const backend = getBackend(browser);

  if (verb === 'start') await start(backend);
  else if (verb === 'stop') await stop(backend, force);
  else if (verb === 'status') process.exitCode = await status(backend);
  else if (verb === 'ensure') await ensure(browser);
  else if (verb === 'serve') await serve(backend);
  else throw new DaemonError('usage: swarm start|stop [--force]|status [chromium|firefox]', 2);
}

// Node realpaths the entry module for import.meta.url, so argv must be
// realpathed too when macOS /var and /tmp symlinks are involved.
if (import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch((error) => {
    if (error instanceof DaemonError) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  });
}
