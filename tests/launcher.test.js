// The TypeScript launcher must supervise the pinned MCP directly and hand every
// invocation a distinct output directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createLauncherFixture, run } from './helpers.js';

const browsers = [
  {
    name: 'chromium',
    endpoint: ['--cdp-endpoint', 'http://localhost:9377'],
    output: /^\/tmp\/claude\/pwmcp-swarm-\d+$/,
  },
  {
    name: 'firefox',
    endpoint: ['--endpoint', 'ws://127.0.0.1:9378/browser-swarm'],
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
  const fixture = createLauncherFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  return fixture;
}

function launch(fixture, browser, argumentLog) {
  const result = runLaunch(fixture, browser, argumentLog, { CLAUDECODE: '' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
}

function runLaunch(fixture, browser, argumentLog, extraEnv) {
  return run(process.execPath, [path.join(fixture, 'src/launch.ts'), browser], {
    env: { ...process.env, ARG_LOG: argumentLog, ...extraEnv },
  });
}
