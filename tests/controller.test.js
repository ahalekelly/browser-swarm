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

  const opened = await controller.call('POST', '/contexts', { backend: 'chrome' });
  assert.equal(opened.status, 200);
  assert.match(opened.body.id, /^c[0-9a-f]{16}$/);
  assert.equal(opened.body.outputDir, path.join(fixture.output, opened.body.id));
  assert.equal(fs.existsSync(opened.body.outputDir), true);

  const called = await controller.call('POST', `/contexts/${opened.body.id}/call`, {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com/one' },
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.text, 'navigated to https://example.com/one\n### Page\n- Page URL: https://example.com/one\n- Page Title: Fake page');
  assert.equal(called.body.isError, false);

  assert.deepEqual((await controller.call('DELETE', `/contexts/${opened.body.id}`)).body, { id: opened.body.id, closed: true });
  assert.deepEqual((await controller.call('DELETE', `/contexts/${opened.body.id}`)).body, { id: opened.body.id, closed: false });
  assert.equal((await controller.call('POST', `/contexts/${opened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 404);
  assert.equal(fs.existsSync(opened.body.outputDir), true, 'closing a context deleted its output dir');
});

test('the dangerous and lifecycle-colliding tools are hidden and refused', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;

  const tools = (await controller.call('POST', `/contexts/${id}/tools`)).body.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['browser_navigate', 'browser_tabs', 'browser_take_screenshot', 'browser_report_blocked']);

  for (const name of ['browser_run_code_unsafe', 'browser_close']) {
    const refused = await controller.call('POST', `/contexts/${id}/call`, { name, arguments: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not available through BrowserSwarm/);
  }
});

test('simultaneous opens share one browser and stay isolated', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  const opened = await Promise.all([0, 1, 2, 3].map(() => controller.call('POST', '/contexts', { backend: 'chrome' })));
  const ids = opened.map((response) => response.body.id);
  assert.equal(new Set(ids).size, 4, 'ids collided');
  assert.equal(await browserConnections(fixture.ports.chrome), 4);
  assert.equal(controller.log().match(/starting headless Chrome/g).length, 1, 'more than one browser was launched');

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
    controller.call('POST', '/contexts', { backend: 'chrome' }),
    controller.call('POST', '/contexts', { backend: 'chrome' }),
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
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;

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
  await controller.call('POST', '/contexts', { backend: 'chrome' });

  await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 8000, 'browser idle stop');
  assert.match(controller.log(), /has had no contexts for .*stopping it/);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].lastCrash, null, 'a deliberate stop was recorded as a crash');

  const reopened = await controller.call('POST', '/contexts', { backend: 'chrome' });
  assert.equal(reopened.status, 200);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].running, true);
});

test('a call that never returns loses its context and leaves siblings working', async (t) => {
  const fixture = await createFixture(t, { CALL_DEADLINE_MS: 700 });
  const controller = await startController(t, fixture);
  const [hung, sibling] = await Promise.all([
    controller.call('POST', '/contexts', { backend: 'chrome' }),
    controller.call('POST', '/contexts', { backend: 'chrome' }),
  ]);

  const lost = await controller.call('POST', `/contexts/${hung.body.id}/call`, { name: 'browser_hang', arguments: {} });
  assert.equal(lost.status, 410);
  assert.match(lost.body.error, new RegExp(`context ${hung.body.id} is lost`));
  assert.equal((await controller.call('POST', `/contexts/${hung.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 410);

  const survivor = await controller.call('POST', `/contexts/${sibling.body.id}/call`, { name: 'browser_tabs', arguments: {} });
  assert.equal(survivor.status, 200);
  await eventually(async () => (await browserConnections(fixture.ports.chrome)) === 1, 5000, 'lost context child exit');
});

test('a rejected tool leaves the context usable', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;

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
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;
  const { pid } = (await controller.call('GET', '/status')).body.browsers[0];

  process.kill(pid, 'SIGKILL');
  await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 5000, 'browser exit');

  const status = (await controller.call('GET', '/status')).body;
  assert.match(status.browsers[0].lastCrash, /exited unexpectedly, losing 1 context/);
  const lost = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_tabs', arguments: {} });
  assert.equal(lost.status, 410);
  assert.match(lost.body.error, /exited, so context .* is lost/);

  const reopened = await controller.call('POST', '/contexts', { backend: 'chrome' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await controller.call('POST', `/contexts/${reopened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);
  assert.match((await controller.call('GET', '/status')).body.browsers[0].lastCrash, /exited unexpectedly/, 'the crash stopped being reported');
});

test('an MCP child that dies alone loses only its own context', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const [crashing, sibling] = await Promise.all([
    controller.call('POST', '/contexts', { backend: 'chrome' }),
    controller.call('POST', '/contexts', { backend: 'chrome' }),
  ]);

  await controller.call('POST', `/contexts/${crashing.body.id}/call`, { name: 'browser_crash', arguments: {} });
  await eventually(async () => (await controller.call('POST', `/contexts/${crashing.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status === 410, 5000, 'context loss');
  assert.equal((await controller.call('POST', `/contexts/${sibling.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);
});

test('a slow cold start is waited out rather than restarted', async (t) => {
  const fixture = await createFixture(t, { browserStartupMs: 3000 });
  const controller = await startController(t, fixture);

  const opened = await controller.call('POST', '/contexts', { backend: 'chrome' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(controller.log().match(/starting headless Chrome/g).length, 1);
});

test('a context whose MCP fails to initialize is not registered', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture, { FAKE_INITIALIZE_ERROR: '1' });

  const failed = await controller.call('POST', '/contexts', { backend: 'chrome' });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /could not start a chrome context/);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
  await eventually(async () => (await browserConnections(fixture.ports.chrome)) === 0, 5000, 'failed child exit');
});

test('repeated open/close cycles leave nothing behind', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  for (let cycle = 0; cycle < 6; cycle += 1) {
    const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;
    await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url: `https://example.com/${cycle}` } });
    await controller.call('DELETE', `/contexts/${id}`);
  }
  await eventually(async () => (await browserConnections(fixture.ports.chrome)) === 0, 5000, 'child cleanup');
  assert.equal((await controller.call('GET', '/status')).body.contexts, 0);
  assert.equal((await controller.call('GET', '/status')).body.browsers[0].running, true, 'the browser was restarted between cycles');
});

test('a large result is previewed and saved in full', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id, outputDir } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;

  const small = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_big', arguments: { lines: 200 } });
  assert.equal(small.body.savedPath, undefined);

  const big = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_big', arguments: { lines: 500 } });
  assert.equal(path.dirname(big.body.savedPath), outputDir);
  assert.equal(fs.readFileSync(big.body.savedPath, 'utf8').split('\n').length, 500);
});

test('artifacts stay readable after the context closes', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;

  const shot = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_take_screenshot', arguments: {} });
  const file = shot.body.text.replace('Saved screenshot to ', '');
  await controller.call('DELETE', `/contexts/${id}`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not really a png');
});

test('a closed context\'s output dir is deleted a day after its last write', async (t) => {
  const fixture = await createFixture(t);
  const stale = path.join(fixture.output, 'c0000000000000001');
  const fresh = path.join(fixture.output, 'c0000000000000002');
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  const twoDaysAgo = Date.now() / 1000 - 2 * 86_400;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  await startController(t, fixture);

  await eventually(() => !fs.existsSync(stale), 5000, 'stale output dir pruned');
  assert.equal(fs.existsSync(fresh), true);
});

test('each context gets its own output dir as its workspace root', async (t) => {
  const fixture = await createFixture(t);
  const argsDir = path.join(fixture.dir, 'args');
  fs.mkdirSync(argsDir);
  const controller = await startController(t, fixture, { FAKE_ARGS_DIR: argsDir });

  const opened = await Promise.all([0, 1].map(() => controller.call('POST', '/contexts', { backend: 'chrome' })));
  const launches = fs.readdirSync(argsDir).map((name) => JSON.parse(fs.readFileSync(path.join(argsDir, name), 'utf8')));
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.deepEqual(launch.argv.slice(0, 3), ['--cdp-endpoint', `http://127.0.0.1:${fixture.ports.chrome}`, '--isolated']);
    assert.deepEqual(launch.argv.slice(5, 7), ['--image-responses', 'omit']);
    assert.equal(launch.cwd, launch.argv[4], 'the child did not run inside its output dir');
  }
  assert.notEqual(launches[0].cwd, launches[1].cwd);
  assert.deepEqual(new Set(launches.map((launch) => launch.cwd)), new Set(opened.map((response) => response.body.outputDir)));
});

test('a session context starts from its saved state and saves back on close', async (t) => {
  const fixture = await createFixture(t);
  const argsDir = path.join(fixture.dir, 'args');
  fs.mkdirSync(argsDir);
  const controller = await startController(t, fixture, { FAKE_ARGS_DIR: argsDir });
  const sessions = path.join(fixture.dir, 'sessions');
  const saved = path.join(sessions, 'shop.json');
  const visited = () => JSON.parse(fs.readFileSync(saved, 'utf8')).cookies.map((cookie) => cookie.value);
  const use = async (url) => {
    const opened = (await controller.call('POST', '/contexts', { backend: 'chrome', session: 'shop' })).body;
    await controller.call('POST', `/contexts/${opened.id}/call`, { name: 'browser_navigate', arguments: { url } });
    const closed = await controller.call('DELETE', `/contexts/${opened.id}`);
    assert.deepEqual(closed.body, { id: opened.id, closed: true, session: 'shop' });
    assert.deepEqual(fs.readdirSync(opened.outputDir), [], 'the exported state was left in the output dir');
    return opened;
  };

  const first = await use('https://example.com/login');
  assert.deepEqual(first.session, { name: 'shop', existing: false });
  assert.deepEqual(visited(), ['https://example.com/login']);
  assert.equal(fs.statSync(sessions).mode & 0o777, 0o700);
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);

  const second = await use('https://example.com/inbox');
  assert.deepEqual(second.session, { name: 'shop', existing: true });
  assert.deepEqual(visited(), ['https://example.com/login', 'https://example.com/inbox']);

  const plain = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;
  assert.equal(plain.session, undefined);
  await controller.call('DELETE', `/contexts/${plain.id}`);
  assert.deepEqual(fs.readdirSync(sessions), ['shop.json']);

  const loaded = fs.readdirSync(argsDir).map((name) => {
    const { argv } = JSON.parse(fs.readFileSync(path.join(argsDir, name), 'utf8'));
    return argv.includes('--storage-state') ? argv[argv.indexOf('--storage-state') + 1] : null;
  });
  assert.deepEqual(loaded.sort(), [saved, null, null]);
});

// Only an explicit close saves, so an abandoned context (an aborted login,
// say) leaves the saved session as it was.
test('expiry and shutdown discard a session context unsaved', async (t) => {
  const fixture = await createFixture(t, { IDLE_MS: 400 });
  const controller = await startController(t, fixture);
  const saved = path.join(fixture.dir, 'sessions/shop.json');
  const open = async (url) => {
    const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome', session: 'shop' })).body;
    await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url } });
    return id;
  };
  await controller.call('DELETE', `/contexts/${await open('https://example.com/kept')}`);
  const before = fs.readFileSync(saved, 'utf8');

  const expiring = await open('https://example.com/abandoned');
  await eventually(() => controller.log().includes(`context ${expiring} idle`), 5000, 'expiry');
  await eventually(async () => (await controller.call('GET', '/contexts')).body.contexts.length === 0, 5000, 'expiry close');
  assert.equal(fs.readFileSync(saved, 'utf8'), before);

  await open('https://example.com/interrupted');
  await controller.stop();
  assert.equal(fs.readFileSync(saved, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(saved)), ['shop.json']);
});

test('a session that cannot be saved fails its close loudly', async (t) => {
  const fixture = await createFixture(t, { SAVE_DEADLINE_MS: 1500 });
  const controller = await startController(t, fixture, { FAKE_SAVE_HANG: '1' });
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome', session: 'shop' })).body;

  const closing = controller.call('DELETE', `/contexts/${id}`);
  // A saving context stays listed and refuses new work and a second close.
  await eventually(async () => (await controller.call('GET', '/contexts')).body.contexts[0]?.busy === true, 2000, 'save start');
  assert.equal((await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_tabs', arguments: {} })).status, 410);
  assert.deepEqual((await controller.call('DELETE', `/contexts/${id}`)).body, { id, closed: false });
  const closed = await closing;
  assert.equal(closed.status, 500);
  assert.match(closed.body.error, new RegExp(`closed ${id}, but session shop was not saved`));
  assert.equal(fs.existsSync(path.join(fixture.dir, 'sessions/shop.json')), false);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('session names are validated and storage tools stay controller-only', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);

  for (const session of ['../escape', 'Shop', '', 'a/b', 7]) {
    const refused = await controller.call('POST', '/contexts', { backend: 'chrome', session });
    assert.equal(refused.status, 400, JSON.stringify(session));
    assert.match(refused.body.error, /session names use only/);
  }

  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome', session: 'shop-2' })).body;
  const tools = (await controller.call('POST', `/contexts/${id}/tools`)).body.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['browser_navigate', 'browser_tabs', 'browser_take_screenshot', 'browser_report_blocked']);
  for (const name of ['browser_cookie_list', 'browser_storage_state']) {
    const refused = await controller.call('POST', `/contexts/${id}/call`, { name, arguments: {} });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not available through BrowserSwarm/);
  }
});

test('the Firefox backend runs its own browser and contexts', async (t) => {
  const fixture = await createFixture(t);
  installFakeFirefox(fixture.dir);
  const controller = await startController(t, fixture);

  const opened = await controller.call('POST', '/contexts', { backend: 'firefox', session: 'shop' });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal((await controller.call('POST', `/contexts/${opened.body.id}/call`, { name: 'browser_tabs', arguments: {} })).status, 200);

  const status = (await controller.call('GET', '/status')).body;
  assert.deepEqual(status.browsers.map((browser) => [browser.backend, browser.running, browser.contexts]), [['firefox', true, 1]]);
  assert.equal((await controller.call('DELETE', `/contexts/${opened.body.id}`)).body.session, 'shop');
});

// Hosts named blocked.* challenge the fake headless Chrome and render on the
// fake headed one; see tests/fixtures/fake-mcp.js.
const linuxOnly = { skip: process.platform !== 'linux' && 'headed Chrome runs only on Linux' };

test('a site that blocks headless Chrome moves the context to headed Chrome, keeping its cookies', linuxOnly, async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome', session: 'shop' })).body;
  const navigate = (url) => controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url } });

  await navigate('https://example.com/x');
  const blocked = await navigate('https://www.blocked.example/a');
  assert.equal(blocked.body.isError, false);
  assert.equal(blocked.body.text, 'navigated to https://www.blocked.example/a\n### Page\n- Page URL: https://www.blocked.example/a\n- Page Title: Fake page');

  const [listed] = (await controller.call('GET', '/contexts')).body.contexts;
  assert.deepEqual([listed.browser, listed.port], ['chrome-headed', fixture.ports.chromeHeaded]);
  const headed = await fetch(`http://127.0.0.1:${fixture.ports.chromeHeaded}/json/version`).then((response) => response.json());
  assert.equal(headed.display, ':99');
  assert.deepEqual((await controller.call('GET', '/status')).body.headedSites.map((site) => site.domain), ['blocked.example']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(fixture.dir, 'headed-sites.json'), 'utf8'))), ['blocked.example']);
  assert.deepEqual(fs.readdirSync(path.join(fixture.output, id)).filter((name) => name.startsWith('.move')), [], 'the moved state was left behind');

  await controller.call('DELETE', `/contexts/${id}`);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'sessions/shop.json'), 'utf8'));
  // The headless visit's datadome cookie stayed behind.
  assert.deepEqual(saved.cookies.map((cookie) => cookie.name), ['visited', 'visited', 'visited']);
});

test('an agent report of a blocked page moves the context to headed Chrome and keeps a sample', linuxOnly, async (t) => {
  const fixture = await createFixture(t);
  installFakeFirefox(fixture.dir);
  const controller = await startController(t, fixture);
  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;
  const tools = (await controller.call('POST', `/contexts/${id}/tools`)).body.tools.map((tool) => tool.name);
  assert.ok(tools.includes('browser_report_blocked'));

  await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url: 'https://quiet.example/page' } });
  const reported = await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_report_blocked', arguments: {} });
  assert.equal(reported.body.text, 'navigated to https://quiet.example/page\n### Page\n- Page URL: https://quiet.example/page\n- Page Title: Fake page');
  assert.equal((await controller.call('GET', '/contexts')).body.contexts[0].browser, 'chrome-headed');
  const status = (await controller.call('GET', '/status')).body;
  assert.deepEqual(status.headedSites.map((site) => site.domain), ['quiet.example']);

  const firefox = (await controller.call('POST', '/contexts', { backend: 'firefox' })).body.id;
  await controller.call('POST', `/contexts/${firefox}/call`, { name: 'browser_navigate', arguments: { url: 'https://other.example/' } });
  const recorded = await controller.call('POST', `/contexts/${firefox}/call`, { name: 'browser_report_blocked', arguments: {} });
  assert.match(recorded.body.text, /no other browser/);

  const samples = fs.readFileSync(path.join(fixture.dir, 'blocked-reports.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(samples.map((sample) => [sample.browser, sample.url, sample.markup]), [
    ['chrome', 'https://quiet.example/page', '<html></html>'],
    ['firefox', 'https://other.example/', '<html></html>'],
  ]);
  assert.equal((await controller.call('GET', '/status')).body.blockedReports, 2);
});

test('learned sites load at startup, open straight in headed Chrome, and expire', linuxOnly, async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'headed-sites.json'), JSON.stringify({
    'blocked.example': new Date(Date.now() + 86_400_000).toISOString(),
    'stale.example': new Date(Date.now() - 1000).toISOString(),
  }));
  const controller = await startController(t, fixture);
  assert.deepEqual((await controller.call('GET', '/status')).body.headedSites.map((site) => site.domain), ['blocked.example']);

  const { id } = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body;
  await controller.call('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url: 'https://shop.blocked.example/' } });
  assert.match(controller.log(), new RegExp(`moved ${id} to chrome-headed`));
  assert.doesNotMatch(controller.log(), /challenged headless Chrome/);

  const plain = (await controller.call('POST', '/contexts', { backend: 'chrome' })).body.id;
  await controller.call('POST', `/contexts/${plain}/call`, { name: 'browser_navigate', arguments: { url: 'https://stale.example/' } });
  const browsers = Object.fromEntries((await controller.call('GET', '/contexts')).body.contexts.map((context) => [context.id, context.browser]));
  assert.deepEqual(browsers, { [id]: 'chrome-headed', [plain]: 'chrome' });
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
  assert.equal((await send({ method: 'POST', route: '/contexts', raw: `{"backend":"chrome","pad":"${'x'.repeat(1024 * 1024)}"}`, contentType: 'application/json' })).status, 413);
  assert.deepEqual((await controller.call('GET', '/contexts')).body.contexts, []);
});

test('SIGTERM closes every context and stops the browser', async (t) => {
  const fixture = await createFixture(t);
  const controller = await startController(t, fixture);
  await controller.call('POST', '/contexts', { backend: 'chrome' });
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
