// The TypeScript launcher must supervise the pinned MCP directly, hand every
// invocation a distinct output directory, and prune stale ones.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createLauncherFixture, run, spawnJsonRpc } from './helpers.js';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const browsers = [
  {
    name: 'chromium',
    endpoint: ['--cdp-endpoint', 'http://localhost:9377'],
  },
  {
    name: 'firefox',
    endpoint: ['--endpoint', 'ws://127.0.0.1:9378/browser-swarm'],
  },
];

for (const browser of browsers) {
  test(`launch.ts supervises ${browser.name} MCP with a private per-session output dir`, (t) => {
    const fixture = createFixture(t);
    const first = launch(fixture, browser.name, path.join(fixture, 'first-args'));
    const second = launch(fixture, browser.name, path.join(fixture, 'second-args'));

    for (const args of [first, second]) {
      assert.deepEqual(args.slice(0, -1), [
        ...browser.endpoint,
        '--isolated',
        '--output-dir',
      ]);
      assert.equal(path.dirname(args.at(-1)), path.join(fixture, 'output'));
      assert.match(path.basename(args.at(-1)), new RegExp(`^${browser.name}-\\d+$`));
    }
    assert.notEqual(first.at(-1), second.at(-1), 'two invocations shared an output dir');
  });
}

test('launch removes output dirs untouched for a day', (t) => {
  const fixture = createFixture(t);
  const stale = path.join(fixture, 'output/chromium-1');
  const fresh = path.join(fixture, 'output/chromium-2');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 60 * 60;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

  launch(fixture, 'chromium', path.join(fixture, 'args'));

  assert.equal(fs.existsSync(stale), false, 'stale output dir survived');
  assert.equal(fs.existsSync(fresh), true, 'fresh output dir was pruned');
});

test('daemon startup errors complete the MCP handshake and expose one error tool', async (t) => {
  const fixture = createFixture(t);
  const argumentLog = path.join(fixture, 'args');
  const error = 'the shared browser could not start';
  const session = spawnLaunch(fixture, 'chromium', argumentLog, { DAEMON_ERROR: error });

  session.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  });
  assert.deepEqual(await session.responses.next((message) => message.id === 1), {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'browser-swarm', version },
    },
  });

  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await session.responses.next((message) => message.id === 2);
  const text = `BrowserSwarm could not attach browser tools to this session. Error: ${error}. Stop and report this error to the orchestrator; do not work around it with other tools.`;
  assert.deepEqual(listed.result.tools, [{
    name: 'browser_swarm_error',
    description: text,
    inputSchema: { type: 'object', properties: {} },
  }]);

  session.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_swarm_error', arguments: {} },
  });
  const called = await session.responses.next((message) => message.id === 3);
  assert.deepEqual(called.result, {
    content: [{ type: 'text', text }],
    isError: true,
  });

  const closed = once(session.child, 'close');
  session.child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 1);
  assert.match(session.stderr(), /ERROR: the shared browser could not start/);
  assert.equal(fs.existsSync(argumentLog), false, 'startup failure launched the MCP');
});

test('Claude canary exposes an error tool before touching the daemon', async (t) => {
  const fixture = createFixture(t);
  const argumentLog = path.join(fixture, 'args');
  const daemonTouch = path.join(fixture, 'daemon-touch');
  const session = spawnLaunch(fixture, 'chromium', argumentLog, {
    CLAUDECODE: '1',
    CLAUDE_MCP_PER_AGENT: '',
    DAEMON_TOUCH_LOG: daemonTouch,
  });

  session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await session.responses.next((message) => message.id === 1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await session.responses.next((message) => message.id === 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['browser_swarm_error']);
  assert.match(listed.result.tools[0].description, /requires patched Claude Code/);

  const closed = once(session.child, 'close');
  session.child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 1);
  assert.match(session.stderr(), /requires patched Claude Code/);
  assert.match(session.stderr(), /claude-patching/);
  assert.match(session.stderr(), /84638/);
  assert.equal(fs.existsSync(daemonTouch), false, 'canary touched the daemon');
  assert.equal(fs.existsSync(argumentLog), false, 'canary launched the MCP');
});

test('Claude canary accepts the per-agent stamp', (t) => {
  const fixture = createFixture(t);
  const argumentLog = path.join(fixture, 'args');
  const daemonTouch = path.join(fixture, 'daemon-touch');
  const result = runLaunch(fixture, 'chromium', argumentLog, {
    CLAUDECODE: '1',
    CLAUDE_MCP_PER_AGENT: '1',
    DAEMON_TOUCH_LOG: daemonTouch,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(daemonTouch), true);
  assert.equal(fs.existsSync(argumentLog), true);
});

function createFixture(t) {
  const fixture = createLauncherFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  return fixture;
}

function launch(fixture, browser, argumentLog) {
  const result = runLaunch(fixture, browser, argumentLog, { CLAUDECODE: '' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
}

function runLaunch(fixture, browser, argumentLog, extraEnv) {
  return run(process.execPath, [path.join(fixture, 'src/launch.ts'), browser], {
    env: { ...process.env, ARG_LOG: argumentLog, ...extraEnv },
  });
}

function spawnLaunch(fixture, browser, argumentLog, extraEnv) {
  const session = spawnJsonRpc(process.execPath, [path.join(fixture, 'src/launch.ts'), browser], {
    env: { ...process.env, ARG_LOG: argumentLog, CLAUDECODE: '', ...extraEnv },
  });
  let stderr = '';
  session.child.stderr.setEncoding('utf8');
  session.child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { ...session, stderr: () => stderr };
}
