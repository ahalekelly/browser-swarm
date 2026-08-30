import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const initializeRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

export function freePort(host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function runDaemon(daemon, verb, browser = 'chromium', ...flags) {
  return run(process.execPath, [daemon, verb, browser, ...flags]);
}

export function tempFixture(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, source), target);
}

export function writeExecutable(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  fs.chmodSync(target, 0o755);
}

export function installFakeChromium(fixture, startupMs = 0) {
  const binary = process.platform === 'darwin'
    ? 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium'
    : 'fingerprint-chromium/chrome';
  writeExecutable(
    path.join(fixture, binary),
    `#!/bin/bash\nexport FAKE_BROWSER_STARTUP_MS=${startupMs}\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`,
  );
}

export function writeDaemonFixture(fixture, replacements = []) {
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

export function createLauncherFixture() {
  const fixture = tempFixture('browser-swarm-launcher-');
  copy('src/launch.ts', path.join(fixture, 'src/launch.ts'));
  copy('package.json', path.join(fixture, 'package.json'));
  fs.writeFileSync(path.join(fixture, 'src/daemon.ts'), `
import { writeFileSync } from 'node:fs';
export class DaemonError extends Error { exitCode = 1; }
export function getBackend(browserName) {
  return { clientEndpoint: browserName === 'chromium' ? 'http://localhost:9377' : 'ws://127.0.0.1:9378/browser-swarm' };
}
export async function ensure() {
  if (process.env.DAEMON_ERROR) throw new DaemonError(process.env.DAEMON_ERROR);
  if (process.env.DAEMON_TOUCH_LOG) writeFileSync(process.env.DAEMON_TOUCH_LOG, 'touched');
}
`);
  copy('tests/fixtures/fake-mcp.js', path.join(fixture, 'node_modules/@playwright/mcp/cli.js'));
  return fixture;
}

export function messageQueue(stream, includeLine = false) {
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

export function spawnJsonRpc(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  return {
    child,
    responses: messageQueue(child.stdout),
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

export async function initialize(session) {
  session.send(initializeRequest);
  await session.responses.next((message) => message.id === 1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
