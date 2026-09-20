import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests copy src/ into a fixture and rewrite these constants, so the suite
// never touches the machine-wide controller.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 9387;
export const OUTPUT_ROOT = '/tmp/claude/swarm';
export const CALL_DEADLINE_MS = 120_000;
export const IDLE_MS = 300_000;

export const TOKEN_FILE = join(ROOT, 'controller-token');
export const SERVICE_HINT = process.platform === 'darwin'
  ? 'launchctl kickstart -k gui/$UID/com.browser-swarm.controller'
  : 'systemctl --user start browser-swarm';
