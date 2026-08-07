const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const daemon = path.join(repo, 'src/daemon.ts');
const mcp = path.join(repo, 'node_modules/@playwright/mcp/cli.js');

test('two MCP sessions use isolated contexts on one Firefox daemon', async (t) => {
  const site = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${request.url}</title><h1>${request.url}</h1>`);
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  t.after(() => site.close());

  runDaemon('stop');
  const started = runDaemon('start');
  assert.equal(started.status, 0, started.stderr);
  t.after(() => runDaemon('stop'));

  const endpoint = fs.readFileSync(path.join(repo, 'firefox-ws-endpoint'), 'utf8').trim();
  assert.match(endpoint, /^ws:\/\//);
  const daemonPid = listenerPid(9378);
  assert.equal(directFirefoxChildren(daemonPid), 1, 'Firefox daemon launched more than one browser process');

  const first = await startMcp(t, endpoint);
  const second = await startMcp(t, endpoint);
  const origin = `http://127.0.0.1:${site.address().port}`;
  await Promise.all([
    first.call('browser_navigate', { url: `${origin}/first` }),
    second.call('browser_navigate', { url: `${origin}/second` }),
  ]);

  const [firstTabs, secondTabs] = await Promise.all([
    first.call('browser_tabs', { action: 'list' }),
    second.call('browser_tabs', { action: 'list' }),
  ]);
  assert.match(firstTabs, /\/first/);
  assert.doesNotMatch(firstTabs, /\/second/);
  assert.match(secondTabs, /\/second/);
  assert.doesNotMatch(secondTabs, /\/first/);
  assert.equal(listenerPid(9378), daemonPid, 'MCP sessions did not share one Firefox daemon');
  assert.equal(establishedClientPids(9378, daemonPid).length, 2);

  await first.stop();
  await waitForClientCount(9378, daemonPid, 1);
  const secondAfterKill = await second.call('browser_tabs', { action: 'list' });
  assert.match(secondAfterKill, /\/second/);
  assert.doesNotMatch(secondAfterKill, /\/first/);

  const late = await startMcp(t, endpoint);
  const lateTabs = await late.call('browser_tabs', { action: 'list' });
  assert.doesNotMatch(lateTabs, /\/first|\/second/, 'late session inherited a reclaimed context');
  assert.equal(listenerPid(9378), daemonPid);
  assert.equal(establishedClientPids(9378, daemonPid).length, 2);
});

async function startMcp(t, endpoint) {
  const output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-firefox-mcp-')));
  const child = spawn(process.execPath, [
    mcp,
    '--endpoint', endpoint,
    '--isolated',
    '--output-dir', output,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const messages = messageQueue(child.stdout);
  let nextId = 1;

  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await messages.next((message) => message.id === id);
    if (response.error) throw new Error(`${response.error.message}\n${stderr}`);
    return response.result;
  };
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'browser-swarm-firefox-test', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.stdin.end();
    const closed = once(child, 'close');
    await Promise.race([closed, delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  t.after(async () => {
    await stop();
    fs.rmSync(output, { recursive: true, force: true });
  });

  return {
    call: async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      return result.content.map((item) => item.text ?? '').join('\n');
    },
    stop,
  };
}

function messageQueue(stream) {
  const queued = [];
  const waiting = [];
  readline.createInterface({ input: stream }).on('line', (line) => {
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

function runDaemon(verb) {
  return spawnSync(process.execPath, [daemon, verb, 'firefox'], { encoding: 'utf8' });
}

function listenerPid(port) {
  const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  assert.equal(pids.length, 1, `expected one listener on ${port}, found ${pids}`);
  return pids[0];
}

function establishedClientPids(port, daemonPid) {
  const result = spawnSync('lsof', ['-t', '-i', `:${port}`, '-sTCP:ESTABLISHED'], { encoding: 'utf8' });
  const pids = new Set(result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : []);
  pids.delete(daemonPid);
  return [...pids];
}

async function waitForClientCount(port, daemonPid, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (establishedClientPids(port, daemonPid).length === expected) return;
    await delay(50);
  }
  assert.equal(establishedClientPids(port, daemonPid).length, expected);
}

function directFirefoxChildren(parentPid) {
  const executable = require('playwright-core').firefox.executablePath();
  const result = spawnSync('ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' });
  return result.stdout.split('\n').filter((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && Number(match[1]) === parentPid && match[2].includes(executable);
  }).length;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
