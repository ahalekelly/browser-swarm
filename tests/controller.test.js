// The controller owns every browser and every context. These tests drive its
// HTTP API against a fake browser and a fake Playwright MCP, so they cover the
// lifecycle rules — isolation, serialization, leases, deadlines, crash
// recovery and the API's security boundary — without launching a real browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  createFixture,
  delay,
  eventually,
  installFakeFirefox,
  request,
  startController,
} from './helpers.js';

test('a context opens, works, and closes idempotently', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  const opened = await controller.call('POST', '/contexts', { backend: 'chromium' });
  assert.equal(opened.status, 200);
  assert.match(opened.body.id, /^c[0-9a-f]{16}$/);
  assert.equal(opened.body.outputDir, path.join(fixture.output, opened.body.id));
  assert.equal(fs.existsSync(opened.body.outputDir), true);

  const called = await controller.call('POST', `/contexts/${opened.body.id}/call`, {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com/one' },
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.text, 'navigated to https://example.com/one');
  assert.equal(called.body.isError, false);

  assert.deepEqual((await controller.call('DELETE', `/contexts/${opened.body.id}`)).body, { id: opened.body.id, closed: true });
  assert.deepEqual((await controller.call('DELETE', `/contexts/${opened.body.id}`)).body, { id: opened.body.id, closed: false });
  assert.equal((await controller.call('POST', `/contexts/${opened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 404);
  assert.equal(fs.existsSync(opened.body.outputDir), true, 'closing a context deleted its output dir');
});

test('the dangerous and lifecycle-colliding tools are hidden and refused', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;

  const tools = (await controller.call('POST', `/contexts/${id}/tools`)).body.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['browser_navigate', 'browser_tabs', 'browser_take_screenshot']);

  for (const name of ['browser_run_code_unsafe', 'browser_close']) {
    const refused = await controller.call('POST', `/contexts/${id}/call`, { name, arguments: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not available through BrowserSwarm/);
  }
});

test('simultaneous opens share one browser and stay isolated', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  const opened = await Promise.all([0, 1, 2, 3].map(() => controller.call('POST', '/contexts', { backend: 'chromium' })));
  const ids = opened.map((response) => response.body.id);
  assert.equal(new Set(ids).size, 4, 'ids collided');
  assert.equal(await browserConnections(fixture.ports.chromium), 4);
  assert.equal(controller.log().match(/starting shared Chromium browser/g).length, 1, 'more than one browser was launched');

  await Promise.all(ids.map((id, index) => controller.call('POST', `/contexts/${id}/call`, {
    name: 'browser_navigate',
    arguments: { url: `https://example.com/${index}` },
  })));
  const listed = (await controller.call('GET', '/contexts')).body.contexts;
  assert.deepEqual(
    listed.map((context) => context.pages).sort(),
    [0, 1, 2, 3].map((index) => [`https://example.com/${index}`]).sort(),
  );
});

test('calls to one context run one at a time while other contexts run concurrently', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const [first, second] = await Promise.all([
    controller.call('POST', '/contexts', { backend: 'chromium' }),
    controller.call('POST', '/contexts', { backend: 'chromium' }),
  ]);

  const slow = (id, ms) => controller.call('POST', `/contexts/${id}/call`, { name: 'browser_slow', arguments: { ms } });
  const serialStart = Date.now();
  await Promise.all([slow(first.body.id, 300), slow(first.body.id, 300)]);
  const serial = Date.now() - serialStart;

  const parallelStart = Date.now();
  await Promise.all([slow(first.body.id, 300), slow(second.body.id, 300)]);
  const parallel = Date.now() - parallelStart;

  assert.ok(serial >= 600, `same-context calls overlapped (${serial}ms)`);
  assert.ok(parallel < serial - 150, `different contexts were serialized (${parallel}ms vs ${serial}ms)`);
});

test('an in-flight call suspends the idle lease and finishing it restarts the lease', async (t) => {
  const fixture = await createFixture(t, { IDLE_MS: 400 });
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;

  const call = controller.call('POST', `/contexts/${id}/call`, { name: 'browser_slow', arguments: { ms: 1200 } });
  await delay(900);
  assert.equal((await controller.call('GET', '/contexts')).body.contexts.length, 1, 'a running call was reaped as idle');
  assert.equal((await call).status, 200);

  await eventually(async () => (await controller.call('GET', '/contexts')).body.contexts.length === 0, 5000, 'idle expiry');
  assert.match(controller.log(), new RegExp(`context ${id} idle`));
});

test('the browser stops after its last context goes idle and restarts on the next open', async (t) => {
  const fixture = await createFixture(t, { IDLE_MS: 400 });
  const controller = await startController(t, fixture);
  await controller.call('POST', '/contexts', { backend: 'chromium' });

  await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 8000, 'browser idle stop');
  assert.match(controller.log(), /has had no contexts for .*stopping it/);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].lastCrash, null, 'a deliberate stop was recorded as a crash');

  const reopened = await controller.call('POST', '/contexts', { backend: 'chromium' });
  assert.equal(reopened.status, 200);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].running, true);
});

test('a call that never returns loses its context and leaves siblings working', async (t) => {
  const fixture = await createFixture(t, { CALL_DEADLINE_MS: 700 });
  const controller = await startController(t, fixture);
  const [hung, sibling] = await Promise.all([
    controller.call('POST', '/contexts', { backend: 'chromium' }),
    controller.call('POST', '/contexts', { backend: 'chromium' }),
  ]);

  const lost = await controller.call('POST', `/contexts/${hung.body.id}/call`, { name: 'browser_hang', arguments: {} });
  assert.equal(lost.status, 410);
  assert.match(lost.body.error, new RegExp(`context ${hung.body.id} is lost`));
  assert.equal((await controller.call('POST', `/contexts/${hung.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 410);

  const survivor = await controller.call('POST', `/contexts/${sibling.body.id}/call`, { name: 'browser_tabs', arguments: {} });
  assert.equal(survivor.status, 200);
  await eventually(async () => (await browserConnections(fixture.ports.chromium)) === 1, 5000, 'lost context child exit');
});

test('a rejected tool leaves the context usable', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;

  const rejected = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_nonsense', arguments: {} });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /unknown tool browser_nonsense/);

  const failed = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_fail', arguments: {} });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.isError, true);
  assert.equal(failed.body.text, 'the page said no');
  assert.equal((await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);
});

test('a browser that dies marks its contexts dead and the next open relaunches it', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;
  const { pid } = (await controller.call('GET', '/status')).body.browsers[0];

  process.kill(pid, 'SIGKILL');
  await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 5000, 'browser exit');

  const status = (await controller.call('GET', '/status')).body;
  assert.match(status.browsers[0].lastCrash, /exited unexpectedly, losing 1 context/);
  const lost = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_tabs', arguments: {} });
  assert.equal(lost.status, 410);
  assert.match(lost.body.error, /exited, so context .* is lost/);

  const reopened = await controller.call('POST', '/contexts', { backend: 'chromium' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await controller.call('POST', `/contexts/${reopened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);
  assert.match((await controller.call('GET', '/status')).body.browsers[0].lastCrash, /exited unexpectedly/, 'the crash stopped being reported');
});

test('an MCP child that dies alone loses only its own context', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const [crashing, sibling] = await Promise.all([
    controller.call('POST', '/contexts', { backend: 'chromium' }),
    controller.call('POST', '/contexts', { backend: 'chromium' }),
  ]);

  await controller.call('POST', `/contexts/${crashing.body.id}/call`, { name: 'browser_crash', arguments: {} });
  await eventually(async () => (await controller.call('POST', `/contexts/${crashing.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status === 410, 5000, 'context loss');
  assert.equal((await controller.call('POST', `/contexts/${sibling.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);
});

test('a slow cold start is waited out rather than restarted', async (t) => {
  const fixture = await createFixture(t, { browserStartupMs: 3000 });
  const controller = await startController(t, fixture);

  const opened = await controller.call('POST', '/contexts', { backend: 'chromium' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(controller.log().match(/starting shared Chromium browser/g).length, 1);
});

test('a context whose MCP fails to initialize is not registered', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture, { FAKE_INITIALIZE_ERROR: '1' });

  const failed = await controller.call('POST', '/contexts', { backend: 'chromium' });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /could not start a chromium context/);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
  await eventually(async () => (await browserConnections(fixture.ports.chromium)) === 0, 5000, 'failed child exit');
});

test('repeated open/close cycles leave nothing behind', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  for (let cycle = 0; cycle < 6; cycle += 1) {
    const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;
    await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url: `https://example.com/${cycle}` } });
    await controller.call('DELETE', `/contexts/${id}`);
  }
  await eventually(async () => (await browserConnections(fixture.ports.chromium)) === 0, 5000, 'child cleanup');
  assert.equal((await controller.call('GET', '/status')).body.contexts, 0);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].running, true, 'the browser was restarted between cycles');
});

test('a large result is previewed and saved in full', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id, outputDir } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;

  const small = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_big', arguments: { lines: 200 } });
  assert.equal(small.body.savedPath, undefined);

  const big = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_big', arguments: { lines: 500 } });
  assert.equal(path.dirname(big.body.savedPath), outputDir);
  assert.equal(fs.readFileSync(big.body.savedPath, 'utf8').split('\n').length, 500);
});

test('artifacts stay readable after the context closes', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chromium' })).body;

  const shot = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_take_screenshot', arguments: {} });
  const file = shot.body.text.replace('Saved screenshot to ', '');
  await controller.call('DELETE', `/contexts/${id}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not really a png');
});

test('each context gets its own output dir as its workspace root', async (t) => {
  const fixture = await createFixture(t);
  const argsDir = path.join(fixture.dir, 'args');
  fs.mkdirSync(argsDir);
  const controller = await startController(t, fixture, { FAKE_ARGS_DIR: argsDir });

  const opened = await Promise.all([0, 1].map(() => controller.call('POST', '/contexts', { backend: 'chromium' })));
  const launches = fs.readdirSync(argsDir).map((name) => JSON.parse(fs.readFileSync(path.join(argsDir, name), 'utf8')));
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.deepEqual(launch.argv.slice(0, 3), ['--cdp-endpoint', `http://127.0.0.1:${fixture.ports.chromium}`, '--isolated']);
    assert.deepEqual(launch.argv.slice(5), ['--image-responses', 'omit']);
    assert.equal(launch.cwd, launch.argv[4], 'the child did not run inside its output dir');
  }
  assert.notEqual(launches[0].cwd, launches[1].cwd);
  assert.deepEqual(new Set(launches.map((launch) => launch.cwd)), new Set(opened.map((response) => response.body.outputDir)));
});

test('the Firefox backend runs its own browser and contexts', async (t) => {
  const fixture = await createFixture(t);
  installFakeFirefox(fixture.dir);
  const controller = await startController(t, fixture);

  const opened = await controller.call('POST', '/contexts', { backend: 'firefox' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal((await controller.call('POST', `/contexts/${opened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);

  const status = (await controller.call('GET', '/status')).body;
  assert.deepEqual(status.browsers.map((browser) => [browser.backend, browser.running, browser.contexts]), [['firefox', true, 1]]);
});

test('the API refuses anything but an authorized, well-formed request', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const host = `127.0.0.1:${fixture.ports.controller}`;
  const send = (options) => request(fixture.ports.controller, options.method ?? 'GET', options.route ?? '/status', options.body, {
    token: 'token' in options ? options.token : controller.token(),
    host: options.host ?? host,
    contentType: options.contentType,
    raw: options.raw,
  });

  assert.equal((await send({ token: undefined })).status, 401);
  assert.equal((await send({ token: 'wrong' })).status, 401);
  assert.equal((await send({ token: `${controller.token()}x` })).status, 401);
  assert.equal((await send({ host: 'evil.example.com' })).status, 400);
  assert.equal((await send({ route: '/nope' })).status, 404);
  assert.equal((await send({ method: 'POST', route: '/contexts', body: { backend: 'webkit' } })).status, 400);
  assert.equal((await send({ method: 'POST', route: '/contexts', raw: '{', contentType: 'application/json' })).status, 400);
  assert.equal((await send({ method: 'POST', route: '/contexts', raw: '{}', contentType: 'text/plain' })).status, 400);
  assert.equal((await send({ method: 'POST', route: '/contexts', raw: `{"backend":"chromium","pad":"${'x'.repeat(1024 * 1024)}"}`, contentType: 'application/json' })).status, 413);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('SIGTERM closes every context and stops the browser', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  await controller.call('POST', '/contexts', { backend: 'chromium' });
  const { pid } = (await controller.call('GET', '/status')).body.browsers[0];

  await controller.stop();
  await eventually(() => !alive(pid), 5000, 'browser shutdown');
  assert.match(controller.log(), /shutting down/);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function browserConnections(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/json/connections', agent: false }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve(JSON.parse(text).connections));
    }).on('error', () => resolve(-1));
  });
}
