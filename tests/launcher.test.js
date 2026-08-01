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

  const first = launch(launcher, node, path.join(fixture, 'first-args'));
  const second = launch(launcher, node, path.join(fixture, 'second-args'));
  const directories = [first, second].map(outputDirectory);
  outputDirectories.push(...directories);

  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) {
    assert.match(directory, /^\/tmp\/claude\/pwmcp-swarm-codex\.[A-Za-z0-9]+$/);
    assert.equal(fs.statSync(directory).isDirectory(), true, 'output directory did not outlive its launcher');
  }

});

function launch(launcher, node, argumentLog) {
  const result = spawnSync(launcher, [node, 'codex'], {
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
