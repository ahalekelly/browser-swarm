#!/usr/bin/env node
// Stand-in for fingerprint-chromium in controller tests: answers CDP's
// /json/version on the given port and keeps running until killed.
// /json/connections reports how many other sockets are attached, which is how
// tests see contexts appear and disappear from the browser's side.
// FAKE_BROWSER_STARTUP_MS stands in for a cold real launch, which opens its
// port long after the process starts.
import http from 'node:http';

const flag = (name) => {
  const argument = process.argv.find((candidate) => candidate.startsWith(`--${name}=`));
  if (!argument) throw new Error(`missing --${name}`);
  return argument.slice(argument.indexOf('=') + 1);
};

const port = Number(flag('remote-debugging-port'));

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/json/version') {
    response.end(JSON.stringify({
      Browser: 'FakeChromium/1',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`,
    }));
    return;
  }
  if (request.url === '/json/connections') {
    server.getConnections((error, count) => {
      response.end(JSON.stringify({ connections: (count ?? 1) - 1 }));
    });
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});

setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.FAKE_BROWSER_STARTUP_MS ?? 0));
