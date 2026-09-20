// The `swarm` CLI is the whole agent-facing surface, including the sandbox
// transport. Normal verbs run against a fixture controller; the transport
// tests run against a stub API and a stub sandbox proxy, because the proxy
// path is the only way into the host's loopback from inside Claude Code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createFixture, freePort, startController, swarm, swarmAsync } from './helpers.js';

const PASSWORD = 'p@ss:word/with specials';

test('open prints a capturable id and reports its output dir', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);

  const opened = swarm(fixture, ['open']);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout.trim(), /^c[0-9a-f]{16}$/);
  assert.equal(opened.stderr.trim(), `output: ${path.join(fixture.output, opened.stdout.trim())}`);
});

test('a tool call prefixes the name, prints the text, and reports tool errors', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  const id = swarm(fixture, ['open']).stdout.trim();

  const called = swarm(fixture, [id, 'navigate', '{"url":"https://example.com/x"}']);
  assert.equal(called.status, 0, called.stderr);
  assert.equal(called.stdout.trim(), 'navigated to https://example.com/x');

  const prefixed = swarm(fixture, [id, 'browser_tabs', '{"action":"list"}']);
  assert.match(prefixed.stdout, /https:\/\/example\.com\/x/);

  const failed = swarm(fixture, [id, 'fail']);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout.trim(), 'the page said no');

  const closed = swarm(fixture, [id, 'close']);
  assert.equal(closed.status, 0);
  assert.match(closed.stderr, new RegExp(`closed ${id}`));
  assert.equal(swarm(fixture, [id, 'tabs', '{"action":"list"}']).status, 4);
});

test('tool arguments can come from stdin', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  const id = swarm(fixture, ['open']).stdout.trim();

  const piped = swarm(fixture, [id, 'navigate', '-'], { input: '{"url":"https://example.com/piped"}' });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout.trim(), 'navigated to https://example.com/piped');

  const broken = swarm(fixture, [id, 'navigate', '-'], { input: 'not json' });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /not valid JSON/);
});

test('tools and help describe what a context can do', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  const id = swarm(fixture, ['open']).stdout.trim();

  const tools = swarm(fixture, [id, 'tools']);
  assert.equal(tools.status, 0, tools.stderr);
  assert.match(tools.stdout, /^navigate {2}Navigate to a URL$/m);
  assert.doesNotMatch(tools.stdout, /run_code_unsafe|browser_/);

  const help = swarm(fixture, [id, 'help', 'navigate']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^navigate$/m);
  assert.match(help.stdout, /"required": \[\n\s+"url"\n\s+\]/);
  assert.equal(swarm(fixture, [id, 'help', 'nonsense']).status, 3);
});

test('a large result is previewed with a path to the full text', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  const id = swarm(fixture, ['open']).stdout.trim();

  const big = swarm(fixture, [id, 'big', '{"lines":500}']);
  assert.equal(big.status, 0, big.stderr);
  const lines = big.stdout.trimEnd().split('\n');
  assert.equal(lines[99], 'line 100');
  const note = lines.at(-1).match(/^\[500 lines; first 100 shown, full text at (.*)\]$/);
  assert.ok(note, `missing the truncation note: ${lines.at(-1)}`);
  assert.equal(fs.readFileSync(note[1], 'utf8').split('\n').length, 500);
});

test('ls and status describe the swarm', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);
  assert.match(swarm(fixture, ['ls']).stdout, /no open contexts/);

  const id = swarm(fixture, ['open']).stdout.trim();
  swarm(fixture, [id, 'navigate', '{"url":"https://example.com/listed"}']);
  const listed = swarm(fixture, ['ls']);
  assert.match(listed.stdout, new RegExp(`${id} {2}chromium`));
  assert.match(listed.stdout, /https:\/\/example\.com\/listed/);

  const status = swarm(fixture, ['status']);
  assert.match(status.stdout, /controller on 127\.0\.0\.1:\d+, 1 context/);
  assert.match(status.stdout, /chromium: pid \d+, up \d+s, 1 context/);
});

test('usage mistakes exit 2 and unknown contexts exit 4', async (t) => {
  const fixture = await createFixture(t);
  await startController(t, fixture);

  assert.equal(swarm(fixture, []).status, 2);
  assert.equal(swarm(fixture, ['open', 'webkit']).status, 2);
  assert.equal(swarm(fixture, ['nonsense']).status, 2);
  const badJson = swarm(fixture, ['c0123456789abcde0', 'navigate', '{oops']);
  assert.equal(badJson.status, 2);
  assert.match(badJson.stderr, /not valid JSON/);
  assert.equal(swarm(fixture, ['c0123456789abcdef', 'tabs', '{}']).status, 4);
});

test('an unreachable controller exits 3 and names the service command', async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'controller-token'), 'unused\n');

  const failed = swarm(fixture, ['status']);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /cannot reach the BrowserSwarm controller at 127\.0\.0\.1:\d+/);
  assert.match(failed.stderr, /systemctl --user start browser-swarm|launchctl kickstart/);
});

test('a missing token says the controller has never run', async (t) => {
  const fixture = await createFixture(t);
  const failed = swarm(fixture, ['status']);
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /no controller token at .*controller-token/);
});

test('the sandbox proxy carries requests to the host loopback', async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'controller-token'), 'fixture-token\n');
  const proxy = await stubProxy(t);

  // Nothing listens on the controller port, so a direct attempt would fail:
  // a 200 here proves the request went through the proxy.
  const opened = await swarmAsync(fixture, ['open'], {
    CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '34717',
    http_proxy: `http://agent:${encodeURIComponent(PASSWORD)}@127.0.0.1:${proxy.port}`,
    no_proxy: '127.0.0.1,localhost',
  });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout.trim(), 'cffffffffffffffff');

  const seen = proxy.requests.at(-1);
  assert.equal(seen.url, `http://127.0.0.1:${fixture.ports.controller}/contexts`, 'the proxy did not get an absolute-form request');
  assert.equal(seen.host, `127.0.0.1:${fixture.ports.controller}`);
  assert.equal(seen.authorization, 'Bearer fixture-token');
  assert.equal(Buffer.from(seen.proxyAuthorization.replace('Basic ', ''), 'base64').toString(), `agent:${PASSWORD}`);
});

test('an ordinary http_proxy is ignored outside the Claude Code sandbox', async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'controller-token'), 'fixture-token\n');
  const proxy = await stubProxy(t);

  const failed = await swarmAsync(fixture, ['status'], {
    CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '',
    http_proxy: `http://agent:${encodeURIComponent(PASSWORD)}@127.0.0.1:${proxy.port}`,
  });
  assert.equal(failed.status, 3);
  assert.equal(proxy.requests.length, 0, 'a corporate proxy was followed');
});

test('proxy credentials never appear in an error', async (t) => {
  const fixture = await createFixture(t);
  fs.writeFileSync(path.join(fixture.dir, 'controller-token'), 'fixture-token\n');
  const dead = await freePort();

  const failed = await swarmAsync(fixture, ['status'], {
    CLAUDE_CODE_HOST_HTTP_PROXY_PORT: '34717',
    http_proxy: `http://agent:${encodeURIComponent(PASSWORD)}@127.0.0.1:${dead}`,
  });
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, new RegExp(`via the sandbox proxy http://127\\.0\\.0\\.1:${dead}`));
  assert.doesNotMatch(failed.stderr, /p@ss|with%20specials|with specials/);
});

async function stubProxy(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      url: request.url,
      host: request.headers.host,
      authorization: request.headers.authorization,
      proxyAuthorization: request.headers['proxy-authorization'],
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'cffffffffffffffff', outputDir: '/tmp/claude/swarm/cffffffffffffffff' }));
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port, requests };
}
