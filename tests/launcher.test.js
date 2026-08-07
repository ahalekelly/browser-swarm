// The TypeScript launcher must wrap the pinned MCP in the idle supervisor and
// hand every invocation a distinct output directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const browsers = [
  {
    name: 'chromium',
    endpoint: ['--cdp-endpoint', 'http://localhost:9377'],
    output: /^\/tmp\/claude\/pwmcp-swarm-\d+$/,
  },
  {
    name: 'firefox',
    endpoint: ['--endpoint', 'ws://[::1]:9378/browser-swarm'],
    output: /^\/tmp\/claude\/pwmcp-firefox-\d+$/,
  },
];

for (const browser of browsers) {
  test(`launch.ts supervises ${browser.name} MCP with a private per-session output dir`, (t) => {
    const fixture = createFixture(t);
    const first = launch(fixture, browser.name, path.join(fixture, 'first-args'));
    const second = launch(fixture, browser.name, path.join(fixture, 'second-args'));

    for (const args of [first, second]) {
      assert.deepEqual(args.slice(0, -1), [
        '300000',
        process.execPath,
        path.join(fs.realpathSync(fixture), 'node_modules/@playwright/mcp/cli.js'),
        ...browser.endpoint,
        '--isolated',
        '--output-dir',
      ]);
      assert.match(args.at(-1), browser.output);
    }
    assert.notEqual(first.at(-1), second.at(-1), 'two invocations shared an output dir');
  });
}

test('Claude canary refuses an unpatched session before touching the daemon', (t) => {
  const fixture = createFixture(t);
  const argumentLog = path.join(fixture, 'args');
  const daemonTouch = path.join(fixture, 'daemon-touch');
  const result = runLaunch(fixture, 'chromium', argumentLog, {
    CLAUDECODE: '1',
    CLAUDE_MCP_PER_AGENT: '',
    DAEMON_TOUCH_LOG: daemonTouch,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires patched Claude Code/);
  assert.match(result.stderr, /claude-patching/);
  assert.match(result.stderr, /84638/);
  assert.equal(fs.existsSync(daemonTouch), false, 'canary touched the daemon');
  assert.equal(fs.existsSync(argumentLog), false, 'canary launched the MCP');
});

test('Claude canary accepts the per-agent stamp', (t) => {
  const fixture = createFixture(t);
  const argumentLog = path.join(fixture, 'args');
  const daemonTouch = path.join(fixture, 'daemon-touch');
  const result = runLaunch(fixture, 'chromium', argumentLog, {
    CLAUDECODE: '1',
    CLAUDE_MCP_PER_AGENT: '1',
    DAEMON_TOUCH_LOG: daemonTouch,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(daemonTouch), true);
  assert.equal(fs.existsSync(argumentLog), true);
});

function createFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-launcher-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sourceDir = path.join(fixture, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'src/launch.ts'), path.join(sourceDir, 'launch.ts'));
  fs.writeFileSync(path.join(sourceDir, 'daemon.ts'), `
import { writeFileSync } from 'node:fs';
export class DaemonError extends Error { exitCode = 1; }
export async function ensure() {
  if (process.env.DAEMON_TOUCH_LOG) writeFileSync(process.env.DAEMON_TOUCH_LOG, 'touched');
}
export async function firefoxEndpoint() { return 'ws://[::1]:9378/browser-swarm'; }
`);
  fs.writeFileSync(path.join(sourceDir, 'mcp-session.ts'), `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)));
`);
  fs.mkdirSync(path.join(fixture, 'node_modules/@playwright/mcp'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'node_modules/@playwright/mcp/cli.js'), '');
  return fixture;
}

function launch(fixture, browser, argumentLog) {
  const result = runLaunch(fixture, browser, argumentLog, { CLAUDECODE: '' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
}

function runLaunch(fixture, browser, argumentLog, extraEnv) {
  return spawnSync(process.execPath, [path.join(fixture, 'src/launch.ts'), browser], {
    encoding: 'utf8',
    env: { ...process.env, ARG_LOG: argumentLog, ...extraEnv },
  });
}
