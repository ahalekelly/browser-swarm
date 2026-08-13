const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const initializeRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

function freePort(host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function runDaemon(daemon, verb, browser = 'chromium', ...flags) {
  return run(process.execPath, [daemon, verb, browser, ...flags]);
}

function tempFixture(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, source), target);
}

function writeExecutable(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  fs.chmodSync(target, 0o755);
}

function installFakeChromium(fixture) {
  writeExecutable(
    path.join(fixture, 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium'),
    `#!/bin/bash\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`,
  );
}

function writeDaemonFixture(fixture, replacements = []) {
  const daemon = path.join(fixture, 'src/daemon.ts');
  let source = fs.readFileSync(path.join(repo, 'src/daemon.ts'), 'utf8');
  for (const [from, to] of replacements) {
    const changed = source.replace(from, to);
    if (changed === source) throw new Error(`daemon fixture replacement not found: ${from}`);
    source = changed;
  }
  fs.mkdirSync(path.dirname(daemon), { recursive: true });
  fs.writeFileSync(daemon, source);
  return daemon;
}

function createLauncherFixture() {
  const fixture = tempFixture('browser-swarm-launcher-');
  copy('src/launch.ts', path.join(fixture, 'src/launch.ts'));
  fs.writeFileSync(path.join(fixture, 'src/daemon.ts'), `
import { writeFileSync } from 'node:fs';
export class DaemonError extends Error { exitCode = 1; }
export function getBackend(browserName) {
  return { clientEndpoint: browserName === 'chromium' ? 'http://localhost:9377' : 'ws://127.0.0.1:9378/browser-swarm' };
}
export async function ensure() {
  if (process.env.DAEMON_TOUCH_LOG) writeFileSync(process.env.DAEMON_TOUCH_LOG, 'touched');
}
`);
  copy('tests/fixtures/fake-mcp.js', path.join(fixture, 'node_modules/@playwright/mcp/cli.js'));
  return fixture;
}

function messageQueue(stream, includeLine = false) {
  const queued = [];
  const waiting = [];
  readline.createInterface({ input: stream }).on('line', (line) => {
    const message = JSON.parse(line);
    queued.push(includeLine ? { ...message, line } : message);
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    async next(matches) {
      for (;;) {
        const index = queued.findIndex(matches);
        if (index !== -1) return queued.splice(index, 1)[0];
        await new Promise((resolve) => waiting.push(resolve));
      }
    },
  };
}

function spawnJsonRpc(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  return {
    child,
    responses: messageQueue(child.stdout),
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

async function initialize(session) {
  session.send(initializeRequest);
  await session.responses.next((message) => message.id === 1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  copy,
  createLauncherFixture,
  delay,
  freePort,
  initialize,
  initializeRequest,
  installFakeChromium,
  messageQueue,
  repo,
  run,
  runDaemon,
  spawnJsonRpc,
  tempFixture,
  writeDaemonFixture,
  writeExecutable,
};
