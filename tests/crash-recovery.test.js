// The crash-recovery property: after a crash, `ensure` restarts the browser
// and deliberately exits nonzero so the sacrificed agent reports the crash —
// and the restarted daemon must survive the harness then killing that failed
// launcher's whole process group. A copy of shared-browser.sh runs against a
// fake browser on a random loopback port and never touches the installed
// daemon.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('a post-crash restart survives the sacrificed launcher process group being killed', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-crash-'));
  const script = path.join(fixture, 'shared-browser.sh');
  const profile = path.join(fixture, 'fingerprint-browser-profile');
  const port = await freePort();
  t.after(() => {
    spawnSync(script, ['stop']);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const binDir = path.join(fixture, 'fingerprint-chromium/Chromium.app/Contents/MacOS');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'Chromium'),
    `#!/bin/bash\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`,
  );
  fs.chmodSync(path.join(binDir, 'Chromium'), 0o755);
  fs.writeFileSync(
    script,
    fs.readFileSync(path.join(repo, 'shared-browser.sh'), 'utf8')
      .replace('PORT=9377', `PORT=${port}`)
      .replace('IDLE_POLL=30', 'IDLE_POLL=1')
      .replace('IDLE_POLLS=10', 'IDLE_POLLS=600'),
  );
  fs.chmodSync(script, 0o755);

  assert.equal(spawnSync(script, ['start'], { encoding: 'utf8' }).status, 0);
  assert.equal(await alive(port), true, 'daemon did not come up');

  // Crash: kill the browser uncleanly, leaving daemon-state at `running`.
  process.kill(browserPid(profile), 'SIGKILL');
  await closedWithin(port, 5000);
  assert.match(fs.readFileSync(path.join(fixture, 'daemon-state'), 'utf8'), /^running /);

  // The sacrificial launch: ensure restarts the browser but must exit 1.
  const launcher = spawn(script, ['ensure'], { detached: true, stdio: 'ignore' });
  const [code] = await new Promise((resolve) => launcher.on('exit', (...result) => resolve(result)));
  assert.equal(code, 1, 'post-crash ensure must fail the sacrificed agent');

  // The harness cleans up the failed launcher's process group; the freshly
  // restarted browser and watchdog must not be in it.
  try { process.kill(-launcher.pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await delay(500);
  assert.equal(await alive(port), true, 'restarted daemon died with the launcher process group');

  // The restart cleared the crash state: the next agent attaches normally.
  assert.equal(spawnSync(script, ['ensure'], { encoding: 'utf8' }).status, 0);
});

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
