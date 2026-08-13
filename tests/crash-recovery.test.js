// After a crash, ensure restarts the browser and deliberately fails so the
// sacrificed agent reports it. The restarted supervisor must survive cleanup
// of that launcher's process group.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  delay,
  freePort,
  installFakeChromium,
  runDaemon,
  tempFixture,
  writeDaemonFixture,
} = require('./helpers');

test('a post-crash restart survives the sacrificed launcher process group being killed', async (t) => {
  const fixture = tempFixture('browser-swarm-crash-');
  const profile = path.join(fixture, 'chromium-browser-profile');
  const port = await freePort();
  installFakeChromium(fixture);
  const daemon = writeDaemonFixture(fixture, [
    ['const port = firefox ? 9378 : 9377;', `const port = firefox ? 9378 : ${port};`],
    ['const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 1_000;'],
    ['const IDLE_POLLS = 10;', 'const IDLE_POLLS = 600;'],
  ]);
  t.after(() => {
    runDaemon(daemon, 'stop', 'chromium', '--force');
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  assert.equal(runDaemon(daemon, 'start').status, 0);
  assert.equal(await alive(port), true, 'daemon did not come up');

  process.kill(browserPid(profile), 'SIGKILL');
  await closedWithin(port, 5000);
  assert.match(fs.readFileSync(path.join(fixture, 'chromium-daemon-state'), 'utf8'), /^running /);

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
