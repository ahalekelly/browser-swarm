// The merged launcher must be invisible on the wire: the pinned Playwright MCP
// is driven through a full handshake directly and under launch.ts, and the two
// transcripts must match byte for byte.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { copy, messageQueue, repo, tempFixture } = require('./helpers');

const node = process.execPath;
const playwrightMcp = path.join(repo, 'node_modules/@playwright/mcp/cli.js');
const mcpArgs = [playwrightMcp, '--cdp-endpoint', 'http://127.0.0.1:1', '--isolated'];

test('the lease supervisor preserves the pinned Playwright MCP wire protocol', async (t) => {
  const fixture = tempFixture('browser-swarm-protocol-');
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const launcher = path.join(fixture, 'src/launch.ts');
  copy('src/launch.ts', launcher);
  fs.writeFileSync(path.join(fixture, 'src/daemon.ts'), `
export class DaemonError extends Error { exitCode = 1; }
export async function ensure() {}
export function getBackend() { return { clientEndpoint: 'http://127.0.0.1:1' }; }
`);
  const source = fs.readFileSync(launcher, 'utf8');
  fs.writeFileSync(launcher, source.replace(
    "const mcp = join(ROOT, 'node_modules/@playwright/mcp/cli.js');",
    `const mcp = ${JSON.stringify(playwrightMcp)};`,
  ));

  const direct = await handshake(t, node, mcpArgs);
  const supervised = await handshake(t, node, [launcher, 'chromium']);
  assert.deepEqual(supervised, direct);
});

async function handshake(t, command, args) {
  const child = spawn(command, args, {
    env: { ...process.env, CLAUDE_MCP_PER_AGENT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const responses = messageQueue(child.stdout, true);
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
