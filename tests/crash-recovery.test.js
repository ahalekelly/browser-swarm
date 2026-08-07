// The crash-recovery property: after a crash, `ensure` restarts the browser
// and deliberately exits nonzero so the sacrificed agent reports the crash.
// The restarted daemon must survive cleanup of that launcher's process group.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('a post-crash restart survives the sacrificed launcher process group being killed', async (t) => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-crash-')));
  const daemon = path.join(fixture, 'src/daemon.ts');
  const profile = path.join(fixture, 'fingerprint-browser-profile');
  const port = await freePort();
  t.after(() => {
    spawnSync(process.execPath, [daemon, 'stop', 'chromium']);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const binDir = path.join(fixture, 'fingerprint-chromium/Chromium.app/Contents/MacOS');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'Chromium'),
    `#!/bin/bash\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`,
  );
  fs.chmodSync(path.join(binDir, 'Chromium'), 0o755);
  fs.mkdirSync(path.dirname(daemon), { recursive: true });
  fs.writeFileSync(
    daemon,
    fs.readFileSync(path.join(repo, 'src/daemon.ts'), 'utf8')
      .replace('port: 9377,', `port: ${port},`)
      .replace("connectionLabel: 'CDP http://localhost:9377',", `connectionLabel: 'CDP http://localhost:${port}',`)
      .replace('const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 1_000;')
      .replace('const IDLE_POLLS = 10;', 'const IDLE_POLLS = 600;')
      .replace('http://localhost:9377', `http://localhost:${port}`),
  );

  assert.equal(runDaemon(daemon, 'start').status, 0);
  assert.equal(await alive(port), true, 'daemon did not come up');

  process.kill(browserPid(profile), 'SIGKILL');
  await closedWithin(port, 5000);
  assert.match(fs.readFileSync(path.join(fixture, 'daemon-state'), 'utf8'), /^running /);

  const launcher = spawn(process.execPath, [daemon, 'ensure', 'chromium'], { detached: true, stdio: 'ignore' });
  const [code] = await new Promise((resolve) => launcher.on('exit', (...result) => resolve(result)));
  assert.equal(code, 1, 'post-crash ensure must fail the sacrificed agent');

  try { process.kill(-launcher.pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await delay(500);
  assert.equal(await alive(port), true, 'restarted daemon died with the launcher process group');
  assert.equal(runDaemon(daemon, 'ensure').status, 0);
});

function runDaemon(daemon, verb) {
  return spawnSync(process.execPath, [daemon, verb, 'chromium'], { encoding: 'utf8' });
}

function browserPid(profile) {
  const found = spawnSync('pgrep', ['-f', `user-data-dir=${profile}`], { encoding: 'utf8' });
  const pids = found.stdout.trim().split('\n').filter(Boolean).map(Number);
  assert.equal(pids.length, 1, `expected one owned browser, found: ${pids}`);
  return pids[0];
}

function alive(port) {
  return fetch(`http://127.0.0.1:${port}/json/version`)
    .then((response) => response.ok)
    .catch(() => false);
}

async function closedWithin(port, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 100) {
    if (!(await alive(port))) return;
    await delay(100);
  }
  assert.fail('port never closed after the browser was killed');
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
