// `swarm mcp` is how Codex agents reach the controller, because their command
// sandbox has no network at all. It owns exactly one context and must keep the
// lifecycle rules the CLI has: one context per session, an idle lease, an
// explicit close, and an agent-visible error when startup fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { createFixture, eventually, initialize, NO_SANDBOX_PROXY, spawnJsonRpc, startController } from './helpers.js';

test('the adapter serves one context and closes it on browser_close', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const session = adapter(t, fixture);

  const initialized = await initialize(session);
  assert.equal(initialized.result.serverInfo.name, 'browser-swarm');

  const tools = await call(session, 2, 'tools/list', {});
  const names = tools.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['browser_navigate', 'browser_tabs', 'browser_take_screenshot', 'browser_close']);

  const navigated = await call(session, 3, 'tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com/mcp' } });
  assert.deepEqual(navigated.result.content, [{ type: 'text', text: 'navigated to https://example.com/mcp' }]);
  assert.equal((await controller.call('GET', '/contexts')).body.contexts.length, 1);

  const closed = await call(session, 4, 'tools/call', { name: 'browser_close', arguments: {} });
  assert.match(closed.result.content[0].text, /^Closed browser context c[0-9a-f]{16}\.$/);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);

  const resumed = await call(session, 5, 'tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com/followup' } });
  assert.equal(resumed.result.isError, true);
  assert.match(resumed.result.content[0].text, /This MCP session is closed.*spawn a fresh browser-swarm agent/);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('a failing tool comes back as a tool error, not a dead session', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  const session = adapter(t, fixture);
  await initialize(session);

  const failed = await call(session, 2, 'tools/call', { name: 'browser_fail', arguments: {} });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, 'the page said no');

  const refused = await call(session, 3, 'tools/call', { name: 'browser_run_code_unsafe', arguments: {} });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /not available through BrowserSwarm/);

  const working = await call(session, 4, 'tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  assert.equal(working.result.isError, false);
});

test('a lost context is reported to the agent', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const session = adapter(t, fixture);
  await initialize(session);
  await call(session, 2, 'tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });

  const { pid } = (await controller.call('GET', '/status')).body.browsers[0];
  process.kill(pid, 'SIGKILL');
  await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 5000, 'browser exit');

  const lost = await call(session, 3, 'tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  assert.equal(lost.result.isError, true);
  assert.match(lost.result.content[0].text, /exited, so context .* is lost/);
});

test('the session drops its context after five idle minutes', async (t) => {
  const fixture = await createFixture(t, { IDLE_MS: 400 });
  const controller = await startController(t, fixture);
  const session = adapter(t, fixture);
  await initialize(session);

  const [code] = await once(session.child, 'close');
  assert.equal(code, 75);
  assert.match(session.stderr(), /Relaunch the browser agent/);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('closing stdin closes the context', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const session = adapter(t, fixture);
  await initialize(session);
  await call(session, 2, 'tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });

  session.child.stdin.end();
  await once(session.child, 'close');
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('a session that cannot get a context still explains itself over MCP', async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'controller-token'), 'nobody-is-listening\n');
  const session = adapter(t, fixture);
  await initialize(session);

  const tools = await call(session, 2, 'tools/list', {});
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['browser_swarm_error']);
  assert.match(tools.result.tools[0].description, /could not attach browser tools/);
  assert.match(tools.result.tools[0].description, /cannot reach the BrowserSwarm controller/);

  const called = await call(session, 3, 'tools/call', { name: 'browser_swarm_error', arguments: {} });
  assert.equal(called.result.isError, true);

  session.child.stdin.end();
  const [code] = await once(session.child, 'close');
  assert.equal(code, 1);
});

function adapter(t, fixture) {
  const session = spawnJsonRpc(process.execPath, [fixture.cli, 'mcp', 'chromium'], {
    env: { ...process.env, ...NO_SANDBOX_PROXY },
  });
  t.after(() => session.child.kill('SIGKILL'));
  return session;
}

async function call(session, id, method, params) {
  session.send({ jsonrpc: '2.0', id, method, params });
  return await session.responses.next((message) => message.id === id);
}
