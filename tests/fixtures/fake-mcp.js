#!/usr/bin/env node
// Stand-in for the pinned Playwright MCP in supervisor tests: speaks just
// enough newline-delimited JSON-RPC to exercise launch.ts, and models the CDP
// connection as one TCP socket to FAKE_CDP_PORT held for the process lifetime.
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';

if (process.env.ARG_LOG) fs.writeFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)));

let cdp;
const nonMessages = [];
const initializeDelay = Number(process.env.FAKE_INITIALIZE_DELAY_MS ?? 0);
const toolDelay = Number(process.env.FAKE_TOOL_DELAY_MS ?? 0);

readline.createInterface({ input: process.stdin })
  .on('close', () => {
    if (!process.env.FAKE_IGNORE_EOF) cdp?.destroy();
  })
  .on('line', (line) => {
    const message = JSON.parse(line);

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      nonMessages.push(line);
      return;
    }

    if (message.method === 'initialize') {
      const respond = () => setTimeout(() => {
        if (process.env.FAKE_INITIALIZE_ERROR) sendError(message.id, 'initialize failed');
        else send(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-playwright-mcp', version: '1.0.0' },
        });
      }, initializeDelay);
      if (process.env.FAKE_ATTACH_ON_INITIALIZE) attach(respond);
      else respond();
      return;
    }

    if (message.method === 'tools/call') {
      attach(() => setTimeout(() => {
        send(message.id, { content: [{ type: 'text', text: 'attached' }] });
      }, toolDelay));
      return;
    }

    if (message.method === 'fake/non-messages') {
      send(message.id, nonMessages);
      return;
    }

    if (message.id !== undefined) send(message.id, {});
  });

function attach(callback) {
  if (cdp) return callback();
  cdp = net.connect(Number(process.env.FAKE_CDP_PORT), '127.0.0.1', callback);
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message },
  })}\n`);
}
