// A cold browser can take longer to open its port than a launcher can wait for
// it. The supervisor must outlast the launcher and adopt the browser, so the
// relaunched agent attaches to a live daemon instead of restarting one that
// killed itself on the way up.
import assert from 'node:assert/strict';
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

test('the supervisor adopts a browser that opens its port after the launcher gives up', async (t) => {
  const fixture = tempFixture('browser-swarm-slow-');
  const port = await freePort();
  installFakeChromium(fixture, 3000);
  const daemon = writeDaemonFixture(fixture, [
    ['const port = firefox ? 9378 : 9377;', `const port = firefox ? 9378 : ${port};`],
    ['const ATTACH_TIMEOUT_MS = 25_000;', 'const ATTACH_TIMEOUT_MS = 1_000;'],
    ['const BOOT_TIMEOUT_MS = 120_000;', 'const BOOT_TIMEOUT_MS = 20_000;'],
  ]);
  t.after(() => {
    runDaemon(daemon, 'stop', 'chromium', '--force');
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const sacrificed = runDaemon(daemon, 'ensure');
  assert.equal(sacrificed.status, 1, 'the launcher should give up before the slow browser is ready');
  assert.match(sacrificed.stderr, /relaunch this agent/);

  await adoptedWithin(path.join(fixture, 'chromium-daemon-state'), 15000);
  assert.equal(runDaemon(daemon, 'ensure').status, 0, 'the relaunched agent should attach to the adopted daemon');
});

async function adoptedWithin(stateFile, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 250) {
    if (fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf8').startsWith('running ')) return;
    await delay(250);
  }
  assert.fail('the supervisor never adopted the slow browser');
}
