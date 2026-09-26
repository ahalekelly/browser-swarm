// Runs Playwright's Firefox server as a process the controller owns. Playwright's
// launchServer ignores its timeout option, so a launch that never finishes can
// only be ended by killing this process. Printing the endpoint signals readiness.
import { firefox } from 'playwright-core';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('usage: firefox-server.ts <ws endpoint>');
const { hostname, port, pathname } = new URL(endpoint);

// Exiting, even mid-launch, runs Playwright's exit hook, which kills the
// browser it spawned and removes its temporary profile.
process.on('SIGTERM', () => process.exit(0));

const server = await firefox.launchServer({
  headless: true,
  // Headless Firefox still plays page audio through the speakers.
  firefoxUserPrefs: { 'media.volume_scale': '0.0' },
  host: hostname,
  port: Number(port),
  wsPath: pathname,
});
server.on('close', () => process.exit(0));
if (server.wsEndpoint() !== endpoint) throw new Error(`Firefox endpoint mismatch: expected ${endpoint}, got ${server.wsEndpoint()}`);
console.log(endpoint);
