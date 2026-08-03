// Launcher argument shape: both launchers must wrap the pinned MCP in the
// idle supervisor and hand every invocation a distinct output dir. The node
// binary is stubbed to log its argv instead of running anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const launchers = [
  {
    script: 'browser-swarm-mcp.sh',
    tag: 'codex',
    stub: { 'shared-browser.sh': '#!/bin/bash\nexit 0\n' },
    pattern: /^\/tmp\/claude\/pwmcp-swarm-codex-\d+$/,
    mcpArgs: ['--cdp-endpoint', 'http://localhost:9377', '--isolated', '--output-dir'],
  },
  {
    script: 'firefox-mcp.sh',
    tag: '1',
    stub: {},
    pattern: /^\/tmp\/claude\/pwmcp-ff-1-\d+$/,
    mcpArgs: ['--browser', 'firefox', '--headless', '--isolated', '--output-dir'],
  },
];

for (const { script, tag, stub, pattern, mcpArgs } of launchers) {
  test(`${script} supervises the pinned MCP with a private per-session output dir`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-launcher-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const launcher = copyExecutable(fixture, script);
    for (const [name, contents] of Object.entries(stub)) copyExecutable(fixture, name, contents);
    const node = copyExecutable(fixture, 'node', '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARG_LOG"\n');

    const first = launch(launcher, node, tag, path.join(fixture, 'first-args'));
    const second = launch(launcher, node, tag, path.join(fixture, 'second-args'));

    for (const args of [first, second]) {
      assert.deepEqual(args.slice(0, -1), [
        path.join(fixture, 'mcp-session.js'),
        '300000',
        node,
        path.join(fixture, 'node_modules/@playwright/mcp/cli.js'),
        ...mcpArgs,
      ]);
      assert.match(args.at(-1), pattern);
    }
    assert.notEqual(first.at(-1), second.at(-1), 'two invocations shared an output dir');
  });
}

function launch(launcher, node, tag, argumentLog) {
  const result = spawnSync(launcher, [node, tag], {
    encoding: 'utf8',
    env: { ...process.env, ARG_LOG: argumentLog },
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(argumentLog, 'utf8').trim().split('\n');
}

function copyExecutable(directory, source, contents) {
  const target = path.join(directory, source);
  fs.writeFileSync(target, contents ?? fs.readFileSync(path.join(repo, source)));
  fs.chmodSync(target, 0o755);
  return target;
}
