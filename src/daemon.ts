import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_PATH = fileURLToPath(import.meta.url);
const IDLE_POLL_MS = 30_000;
const IDLE_POLLS = 10;

export type BrowserName = 'chromium';

type Backend = {
  key: 'chromium-cdp';
  browserName: BrowserName;
  displayName: string;
  port: number;
  profile: string;
  log: string;
  stateFile: string;
  ownershipMarker: string;
  connectionLabel: string;
};

type Reporter = {
  out(message: string): void;
  error(message: string): void;
};

export class DaemonError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const defaultReporter: Reporter = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
};

export function getBackend(name: BrowserName): Backend {
  if (name !== 'chromium') throw new DaemonError(`unknown browser: ${name}`, 2);
  const profile = join(ROOT, 'fingerprint-browser-profile');
  return {
    key: 'chromium-cdp',
    browserName: 'chromium',
    displayName: 'shared Chromium browser',
    port: 9377,
    profile,
    log: join(ROOT, 'shared-browser.log'),
    stateFile: join(ROOT, 'daemon-state'),
    ownershipMarker: `--user-data-dir=${profile}`,
    connectionLabel: 'CDP http://localhost:9377',
  };
}

export async function ensure(name: BrowserName, reporter = defaultReporter): Promise<void> {
  const backend = getBackend(name);
  if (!(await alive(backend)) && ownerPid(backend) === undefined && crashed(backend)) {
    await start(backend, reporter);
    throw new DaemonError(`shared browser crashed since its last clean shutdown (see ${backend.log}) — it has been restarted, but this agent's MCP is deliberately failed so the crash gets reported. Relaunch the agent to attach normally.`);
  }
  await start(backend, reporter);
}

async function start(backend: Backend, reporter: Reporter): Promise<void> {
  if (await alive(backend)) {
    const owner = ownerPid(backend);
    if (owner !== undefined) {
      markRunning(backend);
      spawnWatchdog(backend, owner);
      reporter.out(`${backend.displayName} already up: pid ${owner}, ${backend.connectionLabel}`);
      return;
    }
    throw new DaemonError(`a foreign CDP browser is serving port ${backend.port} — refusing to share it (see: lsof -i :${backend.port})`);
  }

  if (hasListener(backend.port)) {
    throw new DaemonError(`port ${backend.port} is taken by a non-CDP process:\n${listenerDetails(backend.port)}`);
  }

  if (crashed(backend)) reporter.error(`warning: previous shared browser instance shut down uncleanly (crashed or killed) — see ${backend.log}`);

  const binary = join(ROOT, 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium');
  if (!isExecutable(binary)) {
    throw new DaemonError(`fingerprint-chromium is not installed (run ${join(ROOT, 'install-fingerprint-chromium.sh')})`);
  }

  const seedFile = join(ROOT, 'fingerprint-seed');
  if (!existsSync(seedFile) || readFileSync(seedFile).length === 0) {
    writeFileSync(seedFile, `${randomBytes(4).readUInt32LE() % 100_000_000}\n`);
  }
  const fingerprint = readFileSync(seedFile, 'utf8').trim();
  mkdirSync(backend.profile, { recursive: true });
  spawnDetached(backend.log, 'taskpolicy', [
    '-c', 'utility', binary,
    '--headless',
    `--fingerprint=${fingerprint}`,
    '--fingerprint-platform=macos',
    '--fingerprint-brand=Chrome',
    `--remote-debugging-port=${backend.port}`,
    backend.ownershipMarker,
    '--no-first-run',
  ]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await alive(backend)) {
      const owner = ownerPid(backend);
      if (owner !== undefined) {
        markRunning(backend);
        spawnWatchdog(backend, owner);
        reporter.out(`${backend.displayName} up: pid ${owner}, ${backend.connectionLabel}`);
        return;
      }
      throw new DaemonError(`lost port ${backend.port} to a foreign CDP browser while starting (see: lsof -i :${backend.port})`);
    }
    await delay(500);
  }

  throw new DaemonError(`browser did not answer on port ${backend.port} within 10s; last log lines:\n${lastLogLines(backend.log)}`);
}

async function stop(backend: Backend, reporter: Reporter): Promise<void> {
  const owner = ownerPid(backend);
  if (owner === undefined) {
    if (await alive(backend)) {
      throw new DaemonError(`the CDP browser on port ${backend.port} is not ours — refusing to kill it (see: lsof -i :${backend.port})`);
    }
    if (crashed(backend)) {
      reporter.out('note: previous instance shut down uncleanly — clearing crash state');
      markClean(backend);
    }
    reporter.out(`${backend.displayName} already stopped`);
    return;
  }

  markClean(backend);
  process.kill(owner);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processExists(owner)) {
      reporter.out(`${backend.displayName} stopped`);
      return;
    }
    await delay(500);
  }
  throw new DaemonError(`pid ${owner} still alive after 10s`);
}

async function status(backend: Backend, reporter: Reporter): Promise<number> {
  const owner = ownerPid(backend);
  if (owner === undefined) {
    if (await alive(backend)) {
      reporter.out(`foreign CDP browser on port ${backend.port} (not started by BrowserSwarm):\n${listenerDetails(backend.port)}`);
    } else {
      reporter.out(`not running (port ${backend.port} closed)`);
      if (crashed(backend)) reporter.out(`last shutdown: unclean — daemon crashed or was killed (the next agent attach restarts it and reports the crash; \`swarm start chromium\` clears the state now)`);
    }
    return 1;
  }

  reporter.out(`pid: ${owner}`);
  const watchdogPid = findWatchdog(backend, owner);
  reporter.out(watchdogPid === undefined
    ? 'watchdog: not running — browser will not auto-stop'
    : `watchdog: pid ${watchdogPid} (auto-stop after ${(IDLE_POLL_MS * IDLE_POLLS) / 1000}s with no attached clients)`);
  reporter.out(`attached clients: ${clientCount(backend, owner)}`);

  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(`http://localhost:${backend.port}`, { timeout: 5000 });
  const contexts = browser.contexts();
  reporter.out(`contexts: ${contexts.length}`);
  for (const context of contexts) {
    reporter.out(`  pages: ${context.pages().map((page) => page.url()).join(', ') || '(none)'}`);
  }
  await browser.close();
  return 0;
}

async function watchdog(backend: Backend, browserPid: number, reporter: Reporter): Promise<void> {
  let idlePolls = 0;
  reporter.out(`${timestamp()} watchdog: watching browser pid ${browserPid}`);
  for (;;) {
    await delay(IDLE_POLL_MS);
    if (ownerPid(backend) !== browserPid) return;
    idlePolls = clientCount(backend, browserPid) === 0 ? idlePolls + 1 : 0;
    if (idlePolls < IDLE_POLLS) continue;
    reporter.out(`${timestamp()} watchdog: no attached clients for ${(IDLE_POLL_MS * IDLE_POLLS) / 1000}s, stopping browser pid ${browserPid}`);
    markClean(backend);
    try {
      process.kill(browserPid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
}

async function alive(backend: Backend): Promise<boolean> {
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

function ownerPid(backend: Backend): number | undefined {
  for (const pid of listenerPids(backend.port)) {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.includes(backend.ownershipMarker)) return pid;
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

function crashed(backend: Backend): boolean {
  if (!existsSync(backend.stateFile)) return false;
  const [state, boot] = readFileSync(backend.stateFile, 'utf8').trim().split(/\s+/);
  return state === 'running' && boot === bootEpoch();
}

function spawnDetached(logPath: string, command: string, args: string[]): void {
  const log = openSync(logPath, 'a');
  spawn(command, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  closeSync(log);
}

function spawnWatchdog(backend: Backend, owner: number): void {
  if (findWatchdog(backend, owner) !== undefined) return;
  spawnDetached(backend.log, process.execPath, [DAEMON_PATH, 'watchdog', backend.browserName, String(owner)]);
}

function findWatchdog(backend: Backend, owner: number): number | undefined {
  const pattern = `${DAEMON_PATH} watchdog ${backend.browserName} ${owner}`;
  const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return Number(result.stdout.trim().split(/\s+/)[0]);
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
  const [verb, browser = 'chromium', pid] = process.argv.slice(2);
  if (browser !== 'chromium') throw new DaemonError(`unknown browser: ${browser}`, 2);
  const backend = getBackend(browser);

  if (verb === 'start') await start(backend, defaultReporter);
  else if (verb === 'stop') await stop(backend, defaultReporter);
  else if (verb === 'status') process.exitCode = await status(backend, defaultReporter);
  else if (verb === 'ensure') await ensure(browser);
  else if (verb === 'watchdog') {
    if (!pid || !Number.isSafeInteger(Number(pid))) throw new DaemonError('watchdog needs the browser pid', 2);
    await watchdog(backend, Number(pid), defaultReporter);
  } else {
    throw new DaemonError('usage: swarm start|stop|status [chromium]', 2);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error instanceof DaemonError) {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  });
}
