import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonError, ensure, getBackend, type BrowserName } from './daemon.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDLE_MS = 300_000;
const TERMINATE_AFTER_MS = 1000;
const KILL_AFTER_MS = 2000;

if (process.env.CLAUDECODE === '1' && process.env.CLAUDE_MCP_PER_AGENT !== '1') {
  console.error('ERROR: BrowserSwarm requires patched Claude Code. This unpatched session shares same-named inline MCP servers between subagents, which makes agents share one browser session. Install the mcp-per-subagent patch from https://github.com/ahalekelly/claude-patching and see https://github.com/anthropics/claude-code/issues/84638.');
  process.exit(1);
}

const browser = process.argv[2] as BrowserName;
if (browser !== 'chromium' && browser !== 'firefox') {
  console.error('usage: launch.ts chromium|firefox');
  process.exit(2);
}

try {
  await ensure(browser);
} catch (error) {
  if (error instanceof DaemonError) {
    console.error(`ERROR: ${error.message}`);
    process.exit(error.exitCode);
  }
  throw error;
}

const backend = getBackend(browser);
const mcp = join(ROOT, 'node_modules/@playwright/mcp/cli.js');
const endpointArgs = browser === 'chromium'
  ? ['--cdp-endpoint', backend.clientEndpoint]
  : ['--endpoint', backend.clientEndpoint];
const output = `/tmp/claude/pwmcp-${browser === 'chromium' ? 'swarm' : 'firefox'}-${process.pid}`;
const child = spawn(process.execPath, [
  mcp,
  ...endpointArgs,
  '--isolated',
  '--output-dir', output,
], { stdio: ['pipe', 'pipe', 'inherit'] });
let initializeId;
let initializeSucceeded = false;
let initialized = false;
let idleTimer;
let stopping = false;
const stopTimers = [];
const clientRequests = new Set();
const serverRequests = new Set();

process.stdin.on('data', observe(onClientMessage));
child.stdout.on('data', observe(onServerMessage));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stdin.on('error', ignoreClosedPipe);
process.stdout.on('error', (error) => {
  ignoreClosedPipe(error);
  stop();
});

process.stdin.on('end', () => stop());
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

child.on('error', (error) => {
  console.error(`BrowserSwarm could not launch Playwright MCP: ${error.message}`);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  clearTimeout(idleTimer);
  for (const timer of stopTimers) clearTimeout(timer);
  if (!stopping && (code !== 0 || signal)) {
    console.error(`BrowserSwarm Playwright MCP exited unexpectedly (${signal ?? `code ${code}`}).`);
  }
  process.exitCode = stopping ? process.exitCode : (code ?? 1);
  process.stdin.destroy();
});

function onClientMessage(message) {
  if (message.method === 'initialize' && hasId(message)) {
    initializeId = key(message.id);
    initializeSucceeded = false;
  }
  if (!initialized && message.method === 'notifications/initialized' && initializeSucceeded) {
    initialized = true;
    refreshIdleTimer();
    return;
  }
  if (!initialized) return;

  if (isCancellation(message)) clientRequests.delete(key(message.params.requestId));
  if (isRequest(message)) clientRequests.add(key(message.id));
  if (isResponse(message)) serverRequests.delete(key(message.id));
  refreshIdleTimer();
}

function onServerMessage(message) {
  if (!initialized && isResponse(message) && key(message.id) === initializeId) {
    initializeSucceeded = 'result' in message;
  }
  if (!initialized) return;

  if (isCancellation(message)) serverRequests.delete(key(message.params.requestId));
  if (isRequest(message)) serverRequests.add(key(message.id));
  if (isResponse(message)) clientRequests.delete(key(message.id));
  refreshIdleTimer();
}

function refreshIdleTimer() {
  clearTimeout(idleTimer);
  if (clientRequests.size || serverRequests.size || stopping) return;
  idleTimer = setTimeout(() => {
    console.error('BrowserSwarm closed this MCP session after 5 minutes without activity. Relaunch the browser agent to use browser tools again.');
    process.exitCode = 75;
    stop();
  }, IDLE_MS);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  process.stdin.unpipe(child.stdin);

  if (signal) {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    child.kill(signal);
    stopTimers.push(setTimeout(() => child.kill('SIGKILL'), TERMINATE_AFTER_MS));
    return;
  }

  child.stdin.end();
  stopTimers.push(setTimeout(() => child.kill('SIGTERM'), TERMINATE_AFTER_MS));
  stopTimers.push(setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS));
}

function observe(onMessage) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return (chunk) => {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      onMessage(message);
    }
  };
}

function hasId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id');
}

function isRequest(message) {
  return typeof message.method === 'string' && hasId(message);
}

function isResponse(message) {
  return !message.method && hasId(message) && ('result' in message || 'error' in message);
}

function isCancellation(message) {
  return message.method === 'notifications/cancelled'
    && message.params
    && Object.prototype.hasOwnProperty.call(message.params, 'requestId');
}

function key(id) {
  return `${typeof id}:${id}`;
}

function ignoreClosedPipe(error) {
  if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
}
