// Agent sandboxes block writes outside a few directories while allowing lsof
// and loopback traffic. Ownership reads must still work: blind-fire start
// reports an existing daemon, while cold start and stop name the required fix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');
const {
  freePort,
  installFakeChromium,
  runDaemon,
  tempFixture,
  writeDaemonFixture,
} = require('./helpers');

test('ownership and attach survive a shell that cannot write beside the daemon', async (t) => {
  const fixture = await daemonFixture(t);
  const started = runDaemon(fixture.daemon, 'start');
  assert.equal(started.status, 0, `cold start failed: ${started.stderr}`);
  assert.equal(await alive(fixture.port), true, 'daemon did not come up');

  fs.chmodSync(fixture.dir, 0o555);
  fs.chmodSync(`${fixture.dir}/chromium-daemon-state`, 0o444);
  const again = runDaemon(fixture.daemon, 'start');
  assert.equal(again.status, 0, 'start against a running daemon must be a read-only attach');
  assert.match(again.stderr, /already up/, `misread our own daemon: ${again.stderr}`);

  const status = runDaemon(fixture.daemon, 'status');
  assert.match(status.stderr, /pid: \d+/);
  assert.doesNotMatch(status.stderr, /watchdog/);

  const denied = runDaemon(fixture.daemon, 'stop');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /cannot write .* unsandboxed shell/);

  fs.chmodSync(fixture.dir, 0o755);
  fs.chmodSync(`${fixture.dir}/chromium-daemon-state`, 0o644);
  assert.equal(runDaemon(fixture.daemon, 'stop').status, 0);
  assert.equal(await alive(fixture.port), false);
});

test('a sandboxed shell cannot cold-start an untracked daemon', async (t) => {
  const fixture = await daemonFixture(t);
  fs.chmodSync(fixture.dir, 0o555);

  const denied = runDaemon(fixture.daemon, 'start');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /cannot write .* unsandboxed shell/);
  assert.equal(await alive(fixture.port), false);
});

async function daemonFixture(t) {
  const dir = tempFixture('browser-swarm-sandbox-');
  const port = await freePort();
  installFakeChromium(dir);
  const daemon = writeDaemonFixture(dir, [
    ['const port = firefox ? 9378 : 9377;', `const port = firefox ? 9378 : ${port};`],
    ['const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 1_000;'],
    ['const IDLE_POLLS = 10;', 'const IDLE_POLLS = 600;'],
  ]);
  t.after(() => {
    fs.chmodSync(dir, 0o755);
    if (fs.existsSync(`${dir}/chromium-daemon-state`)) fs.chmodSync(`${dir}/chromium-daemon-state`, 0o644);
    runDaemon(daemon, 'stop', 'chromium', '--force');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, daemon, port };
}

function alive(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
  });
}
