import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function freePort() {
  return (await freePorts(1))[0];
}

// Held open together so one fixture never gets the same port twice.
export async function freePorts(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

export function tempFixture(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function eventually(check, milliseconds = 5000, what = 'condition') {
  for (let waited = 0; waited < milliseconds; waited += 50) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${what} never happened within ${milliseconds}ms`);
}

// A fixture is a full copy of src/ with its constants and ports rewritten,
// plus a node_modules that resolves the real SDK and a fake Playwright MCP.
// Tests therefore never touch the machine-wide controller, its port, or its
// token, and five-minute leases become fractions of a second.
export async function createFixture(t, overrides = {}) {
  const dir = tempFixture('browser-swarm-');
  const output = path.join(dir, 'output');
  const [controllerPort, chromiumPort, firefoxPort] = await freePorts(3);
  const ports = { controller: controllerPort, chromium: chromiumPort, firefox: firefoxPort };
  const constants = {
    IDLE_MS: 60_000,
    CALL_DEADLINE_MS: 5_000,
    SWEEP_MS: 100,
    BOOT_TIMEOUT_MS: 10_000,
    CONNECT_TIMEOUT_MS: 5_000,
    CONNECT_DEADLINE_MS: 5_000,
    TOTAL_DEADLINE_MS: 20_000,
    ...overrides,
  };

  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'browser-swarm-fixture', version: '0.0.0', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'fingerprint-seed'), '12345678\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  for (const name of ['config.ts', 'api.ts', 'controller.ts', 'cli.ts', 'mcp.ts']) {
    let source = fs.readFileSync(path.join(repo, 'src', name), 'utf8');
    for (const [key, value] of Object.entries(constants)) {
      source = source.replace(new RegExp(`(const ${key} = )[\\d_]+`), `$1${value}`);
    }
    source = source
      .replace('export const PORT = 9387;', `export const PORT = ${ports.controller};`)
      .replace(/export const OUTPUT_ROOT = '[^']*';/, `export const OUTPUT_ROOT = ${JSON.stringify(output)};`)
      .replace('port: firefox ? 9378 : 9377,', `port: firefox ? ${ports.firefox} : ${ports.chromium},`)
      .replace(
        "endpoint: firefox ? 'ws://127.0.0.1:9378/browser-swarm' : 'http://127.0.0.1:9377',",
        `endpoint: firefox ? 'ws://127.0.0.1:${ports.firefox}/browser-swarm' : 'http://127.0.0.1:${ports.chromium}',`,
      );
    fs.writeFileSync(path.join(dir, 'src', name), source);
  }

  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules/@modelcontextprotocol'), path.join(dir, 'node_modules/@modelcontextprotocol'));
  if (overrides.realBrowser) {
    // The real gate: real browsers, real Playwright MCP, but still a private
    // profile, a private output root and allocated ports.
    fs.symlinkSync(path.join(repo, 'node_modules/@playwright'), path.join(dir, 'node_modules/@playwright'));
    fs.symlinkSync(path.join(repo, 'node_modules/playwright-core'), path.join(dir, 'node_modules/playwright-core'));
    fs.symlinkSync(path.join(repo, 'node_modules/playwright'), path.join(dir, 'node_modules/playwright'));
    fs.symlinkSync(path.join(repo, 'fingerprint-chromium'), path.join(dir, 'fingerprint-chromium'));
  } else {
    fs.mkdirSync(path.join(dir, 'node_modules/@playwright/mcp'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'tests/fixtures/fake-mcp.js'), path.join(dir, 'node_modules/@playwright/mcp/cli.js'));
    installFakeChromium(dir, overrides.browserStartupMs ?? 0);
  }

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, output, ports, controller: path.join(dir, 'src/controller.ts'), cli: path.join(dir, 'src/cli.ts') };
}

export function installFakeChromium(dir, startupMs = 0) {
  const binary = process.platform === 'darwin'
    ? 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium'
    : 'fingerprint-chromium/chrome';
  const target = path.join(dir, binary);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `#!/bin/bash\nexport FAKE_BROWSER_STARTUP_MS=${startupMs}\nexec "${process.execPath}" "${repo}/tests/fixtures/fake-browser.js" "$@"\n`);
  fs.chmodSync(target, 0o755);
}

export function installFakeFirefox(dir) {
  const moduleDir = path.join(dir, 'node_modules/playwright-core');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(moduleDir, 'index.js'), `
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
export const firefox = {
  launchServer: ({ host, port, wsPath }) => new Promise((resolve) => {
    const events = new EventEmitter();
    const sockets = new Set();
    const listener = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    listener.listen(port, host, () => resolve({
      wsEndpoint: () => \`ws://\${host}:\${port}\${wsPath}\`,
      process: () => ({ pid: process.pid }),
      on: events.on.bind(events),
      close: () => new Promise((closed) => {
        for (const socket of sockets) socket.destroy();
        listener.close(() => {
          events.emit('close');
          closed();
        });
      }),
    }));
  }),
};
`);
}

// Starts a fixture controller and returns a client for its API.
export async function startController(t, fixture, env = {}) {
  const port = fixture.ports.controller;
  const child = spawn(process.execPath, [fixture.controller], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let exit;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    exit = signal ?? `code ${code}`;
    resolve();
  }));
  // SIGTERM so the controller stops its browsers; a leaked fake browser would
  // hold a port that the next fixture could be handed.
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([closed, delay(3000)]);
    child.kill('SIGKILL');
  });

  const token = () => fs.readFileSync(path.join(fixture.dir, 'controller-token'), 'utf8').trim();
  const call = (method, route, body, options = {}) => request(port, method, route, body, {
    token: token(),
    host: `127.0.0.1:${port}`,
    ...options,
  }).catch((error) => {
    throw new Error(`${method} ${route} failed: ${error.message}${exit ? ` (controller exited: ${exit})` : ''}\n--- controller log ---\n${log}`);
  });
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`controller exited: ${log}`);
    if (!fs.existsSync(path.join(fixture.dir, 'controller-token'))) return false;
    return (await call('GET', '/status').catch(() => ({ status: 0 }))).status === 200;
  }, 10_000, 'controller startup');

  return {
    port,
    child,
    call,
    token,
    log: () => log,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

export function request(port, method, route, body, { token, host, contentType = 'application/json', raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers = { host };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (payload !== undefined) {
    headers['content-type'] = contentType;
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path: route, method, headers, agent: false }, (incoming) => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { text += chunk; });
      incoming.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: incoming.statusCode, body: parsed });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

// A fixture controller listens inside whatever sandbox runs the suite, so the
// CLI must not take its usual route out to the host's loopback. The proxy
// tests set these back deliberately.
export const NO_SANDBOX_PROXY = { CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '', http_proxy: '', HTTP_PROXY: '' };

export function swarm(fixture, args, { input = '', ...env } = {}) {
  return run(process.execPath, [fixture.cli, ...args], { env: { ...process.env, ...NO_SANDBOX_PROXY, ...env }, input });
}

// For tests whose stub server answers from this process: spawnSync would block
// the event loop that has to serve the request.
export function swarmAsync(fixture, args, { input = '', ...env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture.cli, ...args], { env: { ...process.env, ...NO_SANDBOX_PROXY, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export function messageQueue(stream) {
  const queued = [];
  const waiting = [];
  readline.createInterface({ input: stream }).on('line', (line) => {
    if (!line.trim()) return;
    queued.push(JSON.parse(line));
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
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    responses: messageQueue(child.stdout),
    stderr: () => stderr,
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

export async function initialize(session) {
  session.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-swarm-test', version: '1.0.0' } },
  });
  const response = await session.responses.next((message) => message.id === 1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return response;
}
