// After a crash, ensure restarts the browser and deliberately fails so the
// sacrificed agent reports it. The restarted supervisor must survive cleanup
// of that launcher's process group.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  delay,
  freePort,
  installFakeChromium,
  runDaemon,
  tempFixture,
  writeDaemonFixture,
} from './helpers.js';

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
    runDaemon(daemon, 'stop');
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
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
  });
}

async function closedWithin(port, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 100) {
    if (!(await alive(port))) return;
    await delay(100);
  }
  assert.fail('port never closed after the browser was killed');
}
