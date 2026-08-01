const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const unsafePathCharacters = ['"', '&', '|', '\\', '\n', '\r', '\t', '$', '`', ';', '#', '[', ']', '(', ')'];
const installers = [
  {
    name: 'Claude',
    script: 'claude-agents/install-agents.sh',
    output: '.claude/agents/browser-swarm-1.md',
  },
  {
    name: 'Codex',
    script: 'codex-agents/install-agents.sh',
    output: '.codex/agents/browser-swarm.toml',
  },
];

for (const installer of installers) {
  test(`${installer.name} installer renders safe paths idempotently`, (t) => {
    const fixture = temporaryDirectory(t);
    const home = path.join(fixture, 'home');
    const checkout = path.join(fixture, 'browser swarm-1.2_test');
    const bin = path.join(fixture, 'node bin-1.2_test');
    fs.symlinkSync(repo, checkout, 'dir');
    fs.mkdirSync(bin);
    const node = path.join(bin, 'node');
    fs.symlinkSync(process.execPath, node);

    const first = run(path.join(checkout, installer.script), home, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(first.status, 0, first.stderr);
    const output = path.join(home, installer.output);
    const rendered = fs.readFileSync(output, 'utf8');
    const second = run(path.join(checkout, installer.script), home, { PATH: `${bin}:${process.env.PATH}` });

    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), rendered);
    assert.match(rendered, new RegExp(escapeRegExp(checkout)));
    assert.match(rendered, new RegExp(escapeRegExp(node)));
    assert.doesNotMatch(rendered, /__[A-Z]+__/);
  });

  test(`${installer.name} installer rejects paths outside the shared safe allowlist before writing`, (t) => {
    const fixture = temporaryDirectory(t);

    for (const character of unsafePathCharacters) {
      const checkoutHome = path.join(fixture, `checkout-home-${character.codePointAt(0)}`);
      const checkout = path.join(fixture, `browser${character}swarm`);
      fs.symlinkSync(repo, checkout, 'dir');
      assertRejectedPath(run(path.join(checkout, installer.script), checkoutHome), checkoutHome, installer.output, character);

      const nodeHome = path.join(fixture, `node-home-${character.codePointAt(0)}`);
      const bin = path.join(fixture, `node${character}bin`);
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      assertRejectedPath(run(path.join(repo, installer.script), nodeHome, {
        PATH: `${bin}:${process.env.PATH}`,
      }), nodeHome, installer.output, character);
    }
  });
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-install-'));
  t.after(() => removeTree(directory));
  return directory;
}

function run(script, home, extraEnv = {}) {
  return spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

function assertRejectedPath(result, home, output, character) {
  assert.notEqual(result.status, 0, `accepted ${JSON.stringify(character)} in a replacement path`);
  assert.match(result.stderr, /safe path characters/, `did not explain rejection of ${JSON.stringify(character)}`);
  assert.equal(fs.existsSync(path.join(home, output)), false, 'wrote an agent definition before rejecting its path');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target)) removeTree(path.join(target, entry));
  fs.rmdirSync(target);
}
