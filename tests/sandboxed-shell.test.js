// Agent sandboxes block process inspection (ps, pgrep) and writes outside a
// few directories, while allowing lsof and loopback traffic. The daemon's read
// paths must keep working there: ownership comes from lsof's file tables, so a
// blind-fire `start` against a running daemon reports "already up" instead of
// misreading our own browser as foreign, and verbs that must write fail with a
// message naming the fix. A copy of the daemon runs against a fake browser on
// a random loopback port and never touches the installed daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('ownership survives a shell that cannot inspect processes', async (t) => {
  const fixture = await daemonFixture(t);

  // Bring the daemon up and interrogate it with ps and pgrep blocked
  // throughout, the way a sandboxed orchestrator shell would.
  const started = run(fixture, 'start');
  assert.equal(started.status, 0, `cold start failed: ${started.stderr}`);
  assert.equal(await alive(fixture.port), true, 'daemon did not come up');

  const again = run(fixture, 'start');
  assert.equal(again.status, 0, 'start against a running daemon must be idempotent');
  assert.match(again.stdout, /already up/, `misread our own daemon: ${again.stderr}`);

  // status reports ownership and the watchdog before dialing CDP, which the
  // fake browser does not implement — only the watchdog line matters here.
  const status = run(fixture, 'status');
  assert.match(status.stdout, /watchdog: unknown/, 'a shell that cannot list processes must say so');

  const stopped = run(fixture, 'stop');
  assert.equal(stopped.status, 0, `stop failed: ${stopped.stderr}`);
  assert.equal(await alive(fixture.port), false, 'browser survived stop');
});

test('a shell that cannot write beside the daemon gets a clear error', async (t) => {
  const fixture = await daemonFixture(t);
  fs.chmodSync(fixture.dir, 0o555);

  const denied = run(fixture, 'start');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /cannot write .* unsandboxed shell/);
  assert.equal(await alive(fixture.port), false, 'start spawned a browser it could not track');
});

// A fixture copy of the daemon on a free port, with a fake browser and with
// ps/pgrep stubbed to fail like a sandbox denying process inspection.
async function daemonFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-sandbox-')));
  const daemon = path.join(dir, 'src/daemon.ts');
  const port = await freePort();
  t.after(() => {
    fs.chmodSync(dir, 0o755); // the write-denied test leaves the dir read-only
    spawnSync(process.execPath, [daemon, 'stop', 'chromium', '--force']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const binDir = path.join(dir, 'fingerprint-chromium/Chromium.app/Contents/MacOS');
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, 'Chromium'),
    `#!/bin/bash\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`,
  );
  fs.mkdirSync(path.dirname(daemon), { recursive: true });
  fs.writeFileSync(
    daemon,
    fs.readFileSync(path.join(repo, 'src/daemon.ts'), 'utf8')
      .replace('port: 9377,', `port: ${port},`)
      .replace('const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 1_000;')
      .replace('const IDLE_POLLS = 10;', 'const IDLE_POLLS = 600;'),
  );

  const stubs = path.join(dir, 'blocked-tools');
  fs.mkdirSync(stubs);
  for (const tool of ['ps', 'pgrep'])
    writeExecutable(path.join(stubs, tool), `#!/bin/bash\necho "${tool}: operation not permitted" >&2\nexit 1\n`);

  return { dir, daemon, port, path: `${stubs}:${process.env.PATH}` };
}

function run(fixture, verb) {
  return spawnSync(process.execPath, [fixture.daemon, verb, 'chromium'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: fixture.path },
  });
}

function writeExecutable(target, contents) {
  fs.writeFileSync(target, contents);
  fs.chmodSync(target, 0o755);
}

// agent: false — a keep-alive socket would count as an attached client and make
// `stop` refuse.
function alive(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
