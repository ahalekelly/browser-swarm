// Cold starts are slow: a first-run browser profile on a loaded machine takes
// tens of seconds to answer. The launcher gives up first, inside its MCP
// client's connection timeout, and the browser it left booting must survive to
// serve the next launch. Ownership must also survive an upgrade that moves the
// files the check reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import {
  delay,
  freePort,
  installFakeChromium,
  run,
  runDaemon,
  tempFixture,
  writeDaemonFixture,
} from './helpers.js';

const PORT_LINE = 'const port = firefox ? 9378 : 9377;';

test('a launcher that gives up leaves a slow cold start booting', async (t) => {
  const { daemon, port } = await fixture(t, 'browser-swarm-slow-boot-', [
    ['const ATTACH_TIMEOUT_MS = 25_000;', 'const ATTACH_TIMEOUT_MS = 1_000;'],
  ]);

  const started = run(process.execPath, [daemon, 'start', 'chromium'], {
    env: { ...process.env, FAKE_BROWSER_STARTUP_MS: '4000' },
  });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /relaunch this agent/);

  await aliveWithin(port, 15_000);
  const again = runDaemon(daemon, 'start');
  assert.equal(again.status, 0, `the browser left booting was not adopted: ${again.stderr}`);
  assert.match(again.stderr, /already up/);
});

test('a running browser stays ours after an upgrade moves its profile', async (t) => {
  const { dir, daemon, port } = await fixture(t, 'browser-swarm-upgrade-', []);
  assert.equal(runDaemon(daemon, 'start').status, 0);
  assert.equal(await alive(port), true, 'daemon did not come up');

  writeDaemonFixture(dir, [
    [PORT_LINE, `const port = firefox ? 9378 : ${port};`],
    ['profile: join(ROOT, `${browserName}-browser-profile`),', 'profile: join(ROOT, `${browserName}-profile-v2`),'],
  ]);

  const again = runDaemon(daemon, 'start');
  assert.equal(again.status, 0, `the running browser was misread as foreign: ${again.stderr}`);
  assert.match(again.stderr, /already up/);
});

async function fixture(t, prefix, replacements) {
  const dir = tempFixture(prefix);
  const port = await freePort();
  installFakeChromium(dir);
  const daemon = writeDaemonFixture(dir, [
    [PORT_LINE, `const port = firefox ? 9378 : ${port};`],
    ...replacements,
  ]);
  t.after(() => {
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

async function aliveWithin(port, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 250) {
    if (await alive(port)) return;
    await delay(250);
  }
  assert.fail('the browser left booting never reached its port');
}
