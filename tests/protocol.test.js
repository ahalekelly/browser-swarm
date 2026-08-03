// The supervisor must be invisible on the wire: the real pinned Playwright
// MCP is driven through a full handshake directly and under mcp-session.js,
// and the two transcripts must match byte for byte.
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const node = process.execPath;
const playwrightMcp = path.join(repo, 'node_modules/@playwright/mcp/cli.js');
const mcpArgs = [
  playwrightMcp,
  '--cdp-endpoint',
  'http://127.0.0.1:1',
  '--isolated',
];

test('the lease supervisor preserves the pinned Playwright MCP wire protocol', async (t) => {
  const direct = await handshake(t, node, mcpArgs);
  const supervised = await handshake(t, node, [
    path.join(repo, 'mcp-session.js'),
    '10000',
    node,
    ...mcpArgs,
  ]);

  assert.deepEqual(supervised, direct);
});

async function handshake(t, command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const responses = messageQueue(child.stdout);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'browser-swarm-test', version: '1.0.0' },
    },
  })}\n`);
  const initialize = await responses.next((message) => message.id === 1);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const tools = await responses.next((message) => message.id === 2);
  child.stdin.end();

  const [code] = await new Promise((resolve) => child.on('close', (...result) => resolve(result)));
  assert.equal(code, 0, stderr);
  return { initialize: initialize.line, tools: tools.line };
}

function messageQueue(stream) {
  const queued = [];
  const waiting = [];
  readline.createInterface({ input: stream }).on('line', (line) => {
    queued.push({ ...JSON.parse(line), line });
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
