// The TypeScript launcher must wrap the pinned MCP in the idle supervisor and
// hand every invocation a distinct output directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');

test('launch.ts supervises Chromium MCP with a private per-session output dir', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-swarm-launcher-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sourceDir = path.join(fixture, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'src/launch.ts'), path.join(sourceDir, 'launch.ts'));
  fs.writeFileSync(path.join(sourceDir, 'daemon.ts'), `
export class DaemonError extends Error { exitCode = 1; }
export async function ensure() {}
`);
  fs.writeFileSync(path.join(sourceDir, 'mcp-session.ts'), `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)));
`);
  fs.mkdirSync(path.join(fixture, 'node_modules/@playwright/mcp'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'node_modules/@playwright/mcp/cli.js'), '');

  const first = launch(fixture, path.join(fixture, 'first-args'));
  const second = launch(fixture, path.join(fixture, 'second-args'));

  for (const args of [first, second]) {
    assert.deepEqual(args.slice(0, -1), [
      '300000',
      process.execPath,
      path.join(fs.realpathSync(fixture), 'node_modules/@playwright/mcp/cli.js'),
      '--cdp-endpoint',
      'http://localhost:9377',
      '--isolated',
      '--output-dir',
    ]);
    assert.match(args.at(-1), /^\/tmp\/claude\/pwmcp-swarm-\d+$/);
  }
  assert.notEqual(first.at(-1), second.at(-1), 'two invocations shared an output dir');
});

function launch(fixture, argumentLog) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'src/launch.ts'), 'chromium'], {
    encoding: 'utf8',
    env: { ...process.env, ARG_LOG: argumentLog },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(argumentLog, 'utf8'));
}
