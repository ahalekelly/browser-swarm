import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

test('Chromium stop writes a clean marker', async (t) => {
  const fixture = await chromiumFixture(t, false);
  assert.equal(runDaemon(fixture.daemon, 'start').status, 0);
  assert.equal(runDaemon(fixture.daemon, 'stop').status, 0);
  assert.equal(state(fixture), 'clean\n');
});

test('Chromium idle expiry writes a clean marker', async (t) => {
  const fixture = await chromiumFixture(t, true);
  assert.equal(runDaemon(fixture.daemon, 'start').status, 0);
  await closedWithin(fixture.port, 5000);
  assert.equal(state(fixture), 'clean\n');
});

async function chromiumFixture(t, shortIdle) {
  const dir = tempFixture('browser-swarm-marker-');
  const port = await freePort();
  installFakeChromium(dir);
  const replacements = [['const port = firefox ? 9378 : 9377;', `const port = firefox ? 9378 : ${port};`]];
  if (shortIdle) replacements.push(
    ['const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 500;'],
    ['const IDLE_POLLS = 10;', 'const IDLE_POLLS = 2;'],
  );
  const daemon = writeDaemonFixture(dir, replacements);
  t.after(() => {
    runDaemon(daemon, 'stop', 'chromium', '--force');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { daemon, dir, port };
}

function state(fixture) {
  return fs.readFileSync(path.join(fixture.dir, 'chromium-daemon-state'), 'utf8');
}

async function closedWithin(port, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 50) {
    const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:LISTEN']);
    if (result.status !== 0) return;
    await delay(50);
  }
  assert.fail(`port ${port} never closed`);
}
