#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const idleMs = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);
const TERMINATE_AFTER_MS = 1000;
const KILL_AFTER_MS = 2000;

if (!Number.isSafeInteger(idleMs) || idleMs <= 0 || !command) {
  console.error('usage: mcp-session.js <idle-ms> <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
});

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
  if (!stopping && (code !== 0 || signal))
    console.error(`BrowserSwarm Playwright MCP exited unexpectedly (${signal ?? `code ${code}`}).`);
  process.exitCode = stopping ? process.exitCode : (code ?? 1);
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
  if (!initialized && isResponse(message) && key(message.id) === initializeId)
    initializeSucceeded = 'result' in message;
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
  }, idleMs);
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
        // The pinned MCP owns validation; the supervisor forwards bytes unchanged.
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
