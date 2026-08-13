// The idle lease through the real TypeScript launcher, with a stub daemon and
// fake MCP. The lease and shutdown grace are shortened so five minutes becomes
// about 100ms.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const {
  copy,
  delay,
  initializeRequest,
  messageQueue,
  tempFixture,
} = require('./helpers');

test('the launcher drops an attached MCP session after five idle minutes', async (t) => {
  const session = await launchSession(t);
  await initialize(session);

  const connected = once(session.connections, 'connection');
  session.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: {} },
  });
  await session.response(2);
  const [socket] = await connected;

  await closesWithin(socket, 500);
  const [code] = await session.exitsWithin(300);
  assert.equal(code, 75);
  assert.match(session.stderr(), /Relaunch the browser agent/);
});

test('an initialized session is leased even when it never calls a tool', async (t) => {
  const session = await launchSession(t, { FAKE_ATTACH_ON_INITIALIZE: '1' });
  const connected = once(session.connections, 'connection');
  await initialize(session);
  const [socket] = await connected;

  await closesWithin(socket, 500);
});

test('slow initialization is not mistaken for an idle session', async (t) => {
  const session = await launchSession(t, {
    FAKE_ATTACH_ON_INITIALIZE: '1',
    FAKE_INITIALIZE_DELAY_MS: '250',
  });
  const connected = once(session.connections, 'connection');
  session.send(initializeRequest);
  const [socket] = await connected;

  await staysOpenFor(socket, 180);
  await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await closesWithin(socket, 500);
});

test('the lease waits for the client initialized notification', async (t) => {
  const session = await launchSession(t, { FAKE_ATTACH_ON_INITIALIZE: '1' });
  const connected = once(session.connections, 'connection');
  session.send(initializeRequest);
  await session.response(1);
  const [socket] = await connected;

  await staysOpenFor(socket, 180);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await closesWithin(socket, 500);
});

test('a failed initialize response never arms the lease', async (t) => {
  const session = await launchSession(t, {
    FAKE_ATTACH_ON_INITIALIZE: '1',
    FAKE_INITIALIZE_ERROR: '1',
  });
  const connected = once(session.connections, 'connection');
  session.send(initializeRequest);
  const response = await session.response(1);
  const [socket] = await connected;

  assert.equal(response.error.message, 'initialize failed');
  await staysOpenFor(socket, 180);
});

test('an in-flight tool call suspends the idle lease', async (t) => {
  const session = await launchSession(t, { FAKE_TOOL_DELAY_MS: '250' });
  await initialize(session);
  const connected = once(session.connections, 'connection');
  session.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: {} },
  });
  const [socket] = await connected;

  await staysOpenFor(socket, 180);
  await session.response(2);
  await closesWithin(socket, 500);
});

test('MCP request activity renews the session lease', async (t) => {
  const session = await launchSession(t, { FAKE_ATTACH_ON_INITIALIZE: '1' });
  const connected = once(session.connections, 'connection');
  await initialize(session);
  const [socket] = await connected;

  await staysOpenFor(socket, 70);
  session.send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
  await session.response(2);
  await staysOpenFor(socket, 70);
  await closesWithin(socket, 300);
});

test('cancelling a tool call resumes its idle lease', async (t) => {
  const session = await launchSession(t, { FAKE_TOOL_DELAY_MS: '1000' });
  await initialize(session);
  const connected = once(session.connections, 'connection');
  session.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: {} },
  });
  const [socket] = await connected;
  session.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 2, reason: 'test complete' },
  });

  await closesWithin(socket, 350);
});

test('a stubborn MCP child is terminated after its shutdown grace', async (t) => {
  const session = await launchSession(t, {
    FAKE_ATTACH_ON_INITIALIZE: '1',
    FAKE_IGNORE_EOF: '1',
  });
  const connected = once(session.connections, 'connection');
  await initialize(session);
  const [socket] = await connected;

  await closesWithin(socket, 500);
});

test('activity in one session never extends an idle sibling lease', async (t) => {
  const idle = await launchSession(t, { FAKE_ATTACH_ON_INITIALIZE: '1' });
  const active = await launchSession(t, {
    FAKE_ATTACH_ON_INITIALIZE: '1',
    FAKE_TOOL_DELAY_MS: '250',
  });
  const idleConnected = once(idle.connections, 'connection');
  const activeConnected = once(active.connections, 'connection');
  await Promise.all([initialize(idle), initialize(active)]);
  const [[idleSocket], [activeSocket]] = await Promise.all([idleConnected, activeConnected]);

  active.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: {} },
  });
  await closesWithin(idleSocket, 500);
  assert.equal(activeSocket.destroyed, false, 'idle sibling cleanup killed an active session');
  await active.response(2);
  await closesWithin(activeSocket, 500);
});

test('valid non-message JSON reaches the MCP without crashing the supervisor', async (t) => {
  const session = await launchSession(t);
  await initialize(session);
  const values = [null, false, 17, 'text', []];
  for (const value of values) session.send(value);
  session.send({ jsonrpc: '2.0', id: 2, method: 'fake/non-messages', params: {} });

  const response = await Promise.race([
    session.response(2),
    delay(300).then(() => assert.fail('the supervisor did not forward valid non-message JSON')),
  ]);

  assert.deepEqual(response.result, values.map(JSON.stringify));
});

test('valid non-message JSON does not renew the idle lease', async (t) => {
  const session = await launchSession(t, { FAKE_ATTACH_ON_INITIALIZE: '1' });
  const connected = once(session.connections, 'connection');
  await initialize(session);
  const [socket] = await connected;

  await staysOpenFor(socket, 70);
  for (const value of [null, false, 17, 'text', []]) session.send(value);
  await closesWithin(socket, 70);
});

async function launchSession(t, extraEnv = {}) {
  const fixture = tempFixture('browser-swarm-idle-');
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  copy('src/launch.ts', path.join(fixture, 'src/launch.ts'));
  fs.writeFileSync(path.join(fixture, 'src/daemon.ts'), `
export class DaemonError extends Error { exitCode = 1; }
export async function ensure() {}
export function getBackend() { return { clientEndpoint: 'http://localhost:9377' }; }
`);
  copy('tests/fixtures/fake-mcp.js', path.join(fixture, 'node_modules/@playwright/mcp/cli.js'));

  const launcher = path.join(fixture, 'src/launch.ts');
  const source = fs.readFileSync(launcher, 'utf8');
  const shortened = source
    .replace('const IDLE_MS = 300_000;', 'const IDLE_MS = 100;')
    .replace('const TERMINATE_AFTER_MS = 1000;', 'const TERMINATE_AFTER_MS = 50;')
    .replace('const KILL_AFTER_MS = 2000;', 'const KILL_AFTER_MS = 100;');
  assert.notEqual(shortened, source, 'launcher must declare the five-minute lease');
  fs.writeFileSync(launcher, shortened);

  const connections = new EventEmitter();
  const cdp = net.createServer((socket) => connections.emit('connection', socket));
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));
  t.after(() => cdp.close());

  let stderr = '';
  const child = spawn(process.execPath, [launcher, 'chromium'], {
    env: {
      ...process.env,
      // Satisfy the launcher canary even when the suite runs under Claude Code.
      CLAUDE_MCP_PER_AGENT: '1',
      FAKE_CDP_PORT: String(cdp.address().port),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'close');

  const responses = messageQueue(child.stdout);
  return {
    connections,
    response: (id) => responses.next((message) => message.id === id),
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    stderr: () => stderr,
    exitsWithin: (milliseconds) => Promise.race([
      exited,
      delay(milliseconds).then(() => assert.fail('idle MCP supervisor did not exit')),
    ]),
  };
}

async function initialize(session) {
  session.send(initializeRequest);
  await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function closesWithin(socket, milliseconds) {
  if (socket.destroyed) return;
  await Promise.race([
    once(socket, 'close'),
    delay(milliseconds).then(() => assert.fail('idle MCP retained its CDP connection')),
  ]);
}

async function staysOpenFor(socket, milliseconds) {
  await delay(milliseconds);
  assert.equal(socket.destroyed, false, 'active MCP lost its CDP connection');
}
