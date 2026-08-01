const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('each Codex launcher invocation gets a persistent private output directory', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-launcher-'));
  const outputDirectories = [];
  t.after(() => {
    for (const directory of outputDirectories) {
      if (directory.startsWith('/tmp/claude/pwmcp-swarm-codex.')) fs.rmdirSync(directory);
    }
    for (const entry of fs.readdirSync(fixture)) fs.unlinkSync(path.join(fixture, entry));
    fs.rmdirSync(fixture);
  });
  const launcher = copyExecutable(fixture, 'browser-swarm-mcp.sh');
  copyExecutable(fixture, 'shared-browser.sh', '#!/bin/bash\nexit 0\n');
  const node = copyExecutable(fixture, 'node', '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARG_LOG"\n');

  const first = launch(launcher, node, 'codex', path.join(fixture, 'first-args'));
  const second = launch(launcher, node, 'codex', path.join(fixture, 'second-args'));
  const directories = [first, second].map(outputDirectory);
  outputDirectories.push(...directories);

  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) {
    assert.match(directory, /^\/tmp\/claude\/pwmcp-swarm-codex\.[A-Za-z0-9]+$/);
    assert.equal(fs.statSync(directory).isDirectory(), true, 'output directory did not outlive its launcher');
  }

});

test('each Firefox launcher invocation preserves supervision and gets a persistent private output directory', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-firefox-launcher-'));
  const outputDirectories = [];
  t.after(() => {
    for (const directory of outputDirectories) {
      if (directory.startsWith('/tmp/claude/pwmcp-ff-1.')) fs.rmdirSync(directory);
    }
    for (const entry of fs.readdirSync(fixture)) fs.unlinkSync(path.join(fixture, entry));
    fs.rmdirSync(fixture);
  });
  const launcher = copyExecutable(fixture, 'firefox-mcp.sh');
  const node = copyExecutable(fixture, 'node', '#!/bin/bash\nprintf "%s\\n" "$@" > "$ARG_LOG"\n');

  const first = launch(launcher, node, '1', path.join(fixture, 'first-args'));
  const second = launch(launcher, node, '1', path.join(fixture, 'second-args'));
  const directories = [first, second].map(outputDirectory);
  outputDirectories.push(...directories);

  const expectedSupervisorArgs = [
    path.join(fixture, 'mcp-session.js'),
    '300000',
    node,
    path.join(fixture, 'node_modules/@playwright/mcp/cli.js'),
    '--browser',
    'firefox',
    '--headless',
    '--isolated',
    '--output-dir',
  ];
  assert.deepEqual(first.slice(0, -1), expectedSupervisorArgs);
  assert.deepEqual(second.slice(0, -1), expectedSupervisorArgs);
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) {
    assert.match(directory, /^\/tmp\/claude\/pwmcp-ff-1\.[A-Za-z0-9]+$/);
    assert.equal(fs.statSync(directory).isDirectory(), true, 'output directory did not outlive its launcher');
  }
});

function launch(launcher, node, agentId, argumentLog) {
  const result = spawnSync(launcher, [node, agentId], {
    encoding: 'utf8',
    env: { ...process.env, ARG_LOG: argumentLog },
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(argumentLog, 'utf8').trim().split('\n');
}

function outputDirectory(args) {
  const flag = args.indexOf('--output-dir');
  assert.notEqual(flag, -1, 'launcher omitted --output-dir');
  return args[flag + 1];
}

function copyExecutable(directory, source, contents) {
  const target = path.join(directory, source);
  fs.writeFileSync(target, contents ?? fs.readFileSync(path.join(repo, source)));
  fs.chmodSync(target, 0o755);
  return target;
}
