// Firefox uses the same detached serve lifecycle as Chromium. A fake
// playwright-core keeps these tests fast while preserving listener ownership,
// attached-client guards, signals, idle expiry, and marker behavior.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { delay, freePort, runDaemon, tempFixture, writeDaemonFixture } from './helpers.js';

test('Firefox starts one owned server at its constant endpoint and stops cleanly', async (t) => {
  const fixture = await firefoxFixture(t);
  const started = runDaemon(fixture.daemon, 'start', 'firefox');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stderr, /shared Firefox browser up/);

  const owner = listenerPid(fixture.port);
  const repeated = runDaemon(fixture.daemon, 'start', 'firefox');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stderr, new RegExp(`already up: pid ${owner}`));
  assert.equal(listenerPid(fixture.port), owner);

  const status = runDaemon(fixture.daemon, 'status', 'firefox');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stderr, new RegExp(`endpoint: ws://127\\.0\\.0\\.1:${fixture.port}/browser-swarm`));

  const client = net.createConnection(fixture.port, '127.0.0.1');
  await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
  const refused = runDaemon(fixture.daemon, 'stop', 'firefox');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /1 attached client — refusing to stop/);
  assert.equal(listenerPid(fixture.port), owner);
  client.destroy();
  await noClientsWithin(fixture.port, owner, 5000);

  const stopped = runDaemon(fixture.daemon, 'stop', 'firefox');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, /shared Firefox browser stopped/);
  assert.equal(listenerPids(fixture.port).length, 0);
  assert.equal(state(fixture), 'clean\n');
});

test('external SIGTERM of the Firefox supervisor leaves the crash marker running', async (t) => {
  const fixture = await firefoxFixture(t);
  assert.equal(runDaemon(fixture.daemon, 'start', 'firefox').status, 0);
  process.kill(listenerPid(fixture.port), 'SIGTERM');
  await closedWithin(fixture.port, 5000);
  assert.match(state(fixture), /^running /);
});

test('Firefox idle expiry writes a clean marker', async (t) => {
  const fixture = await firefoxFixture(t, true);
  assert.equal(runDaemon(fixture.daemon, 'start', 'firefox').status, 0);
  await closedWithin(fixture.port, 5000);
  assert.equal(state(fixture), 'clean\n');
});

async function firefoxFixture(t, shortIdle = false) {
  const fixture = tempFixture('browser-swarm-firefox-');
  const port = await freePort();
  const replacements = [
    ["const FIREFOX_ENDPOINT = 'ws://127.0.0.1:9378/browser-swarm';", `const FIREFOX_ENDPOINT = 'ws://127.0.0.1:${port}/browser-swarm';`],
    ['const port = firefox ? 9378 : 9377;', `const port = firefox ? ${port} : 9377;`],
  ];
  if (shortIdle) replacements.push(
    ['const IDLE_POLL_MS = 30_000;', 'const IDLE_POLL_MS = 50;'],
    ['const IDLE_POLLS = 10;', 'const IDLE_POLLS = 2;'],
  );
  const daemon = writeDaemonFixture(fixture, replacements);
  installFakePlaywright(fixture);
  t.after(() => {
    runDaemon(daemon, 'stop', 'firefox', '--force');
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  return { daemon, dir: fixture, port };
}

function installFakePlaywright(fixture) {
  const moduleDir = path.join(fixture, 'node_modules/playwright-core');
  const executable = path.join(fixture, 'fake-firefox');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(executable, '#!/bin/bash\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(moduleDir, 'index.js'), `
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
export const firefox = {
  executablePath: () => ${JSON.stringify(executable)},
  launchServer: ({ host, port, wsPath }) => new Promise((resolve) => {
    const events = new EventEmitter();
    const listener = createServer(() => {});
    listener.listen(port, host, () => resolve({
      wsEndpoint: () => \`ws://\${host}:\${port}\${wsPath}\`,
      on: events.on.bind(events),
      close: () => new Promise((closed) => listener.close(() => {
        events.emit('close');
        closed();
      })),
    }));
  }),
};
`);
}

function state(fixture) {
  return fs.readFileSync(path.join(fixture.dir, 'firefox-daemon-state'), 'utf8');
}

function listenerPid(port) {
  const pids = listenerPids(port);
  assert.equal(pids.length, 1, `expected one listener on ${port}, found ${pids}`);
  return pids[0];
}

function listenerPids(port) {
  const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : [];
}

async function noClientsWithin(port, owner, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 100) {
    const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
    const pids = new Set(result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : []);
    pids.delete(owner);
    if (pids.size === 0) return;
    await delay(100);
  }
  assert.fail('client connection never cleared');
}

async function closedWithin(port, milliseconds) {
  for (let waited = 0; waited < milliseconds; waited += 50) {
    if (listenerPids(port).length === 0) return;
    await delay(50);
  }
  assert.fail(`port ${port} never closed`);
}
