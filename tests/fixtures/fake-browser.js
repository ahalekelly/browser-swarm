#!/usr/bin/env node
// Stand-in for fingerprint-chromium in daemon tests: answers CDP's
// /json/version on the given port and keeps running until killed. It holds a
// file inside the passed profile dir open for its whole lifetime — real
// Chromium always does — which is what the daemon's port-derived ownership
// check looks for.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const flag = (name) => {
  const argument = process.argv.find((candidate) => candidate.startsWith(`--${name}=`));
  if (!argument) throw new Error(`missing --${name}`);
  return argument.slice(argument.indexOf('=') + 1);
};

const port = Number(flag('remote-debugging-port'));
const profile = flag('user-data-dir');

fs.mkdirSync(profile, { recursive: true });
fs.openSync(path.join(profile, 'FakeBrowserLock'), 'w'); // held open until exit

http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/json/version') {
    response.end(JSON.stringify({
      Browser: 'FakeChromium/1',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
}).listen(port, '127.0.0.1');
