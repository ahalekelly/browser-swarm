#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const portArgument = process.argv.find((argument) =>
  argument.startsWith("--remote-debugging-port="),
);

if (!portArgument) throw new Error("missing --remote-debugging-port");

const port = Number(portArgument.slice(portArgument.indexOf("=") + 1));
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/json/version") {
    response.end(
      JSON.stringify({
        Browser: "FakeChromium/1",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`,
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

const immediate = process.argv.includes("--immediate");
if (!immediate && fs.existsSync(path.join(__dirname, "never-listen"))) {
  setInterval(() => {}, 60_000);
} else if (!immediate && fs.existsSync(path.join(__dirname, "delay-start"))) {
  setTimeout(() => server.listen(port, "127.0.0.1"), 2_000);
} else {
  server.listen(port, "127.0.0.1");
}
