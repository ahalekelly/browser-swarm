// Firefox uses the same detached lifecycle as Chromium. A fake playwright-core
// launchServer keeps this test fast while preserving the listener, endpoint,
// ownership, watchdog, and clean-stop behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('the Firefox backend starts one owned server and preserves its reported endpoint', async (t) => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-firefox-')));
  const daemon = path.join(fixture, 'src/daemon.ts');
  const port = await freePort();
  t.after(() => {
    run(daemon, 'stop');
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  fs.mkdirSync(path.dirname(daemon), { recursive: true });
  fs.writeFileSync(
    daemon,
    fs.readFileSync(path.join(repo, 'src/daemon.ts'), 'utf8').replace('port: 9378,', `port: ${port},`),
  );
  installFakePlaywright(fixture);

  const started = run(daemon, 'start');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /shared Firefox browser up/);
  assert.equal(
    fs.readFileSync(path.join(fixture, 'firefox-ws-endpoint'), 'utf8').trim(),
    `ws://[::1]:${port}/browser-swarm`,
  );

  const owner = listenerPid(port);
  const repeated = run(daemon, 'start');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, new RegExp(`already up: pid ${owner}`));
  assert.equal(listenerPid(port), owner, 'idempotent start replaced the Firefox server');

  const status = run(daemon, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`endpoint: ws://\\[::1\\]:${port}/browser-swarm`));

  const stopped = run(daemon, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /shared Firefox browser stopped/);
  assert.equal(listenerPids(port).length, 0);
  assert.equal(fs.readFileSync(path.join(fixture, 'firefox-daemon-state'), 'utf8'), 'clean\n');
});

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
  launchServer: ({ port, wsPath }) => new Promise((resolve) => {
    const events = new EventEmitter();
    const listener = createServer((socket) => socket.end());
    listener.listen(port, '::1', () => resolve({
      wsEndpoint: () => \`ws://[::1]:\${port}\${wsPath}\`,
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

function run(daemon, verb) {
  return spawnSync(process.execPath, [daemon, verb, 'firefox'], { encoding: 'utf8' });
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

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '::1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
