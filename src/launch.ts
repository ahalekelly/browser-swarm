import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonError, ensure, firefoxEndpoint, type BrowserName } from './daemon.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDLE_MS = 300_000;

const browser = process.argv[2] as BrowserName;
if (browser !== 'chromium' && browser !== 'firefox') {
  console.error('usage: launch.ts chromium|firefox');
  process.exit(2);
}

try {
  await ensure(browser, {
    out: (message) => console.error(message),
    error: (message) => console.error(message),
  });
  const endpointArgs = browser === 'chromium'
    ? ['--cdp-endpoint', 'http://localhost:9377']
    : ['--endpoint', await firefoxEndpoint()];
  const supervisor = join(ROOT, 'src/mcp-session.ts');
  const mcp = join(ROOT, 'node_modules/@playwright/mcp/cli.js');
  const output = `/tmp/claude/pwmcp-${browser === 'chromium' ? 'swarm' : 'firefox'}-${process.pid}`;
  process.execve(process.execPath, [
    process.execPath,
    supervisor,
    String(IDLE_MS),
    process.execPath,
    mcp,
    ...endpointArgs,
    '--isolated',
    '--output-dir', output,
  ], process.env);
} catch (error) {
  if (error instanceof DaemonError) {
    console.error(`ERROR: ${error.message}`);
    process.exit(error.exitCode);
  }
  throw error;
}
