#!/usr/bin/env node
// Stand-in for the pinned Playwright MCP in controller tests: speaks the
// newline-delimited JSON-RPC the SDK client expects, and models the browser
// connection as one TCP socket to the endpoint's port held for the process
// lifetime, so tests can count live contexts from the browser's side.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const endpoint = new URL(flag('--cdp-endpoint') ?? flag('--endpoint'));
const outputDir = flag('--output-dir');
if (process.env.FAKE_ARGS_DIR) {
  fs.writeFileSync(path.join(process.env.FAKE_ARGS_DIR, `args-${process.pid}.json`), JSON.stringify({ argv, cwd: process.cwd() }));
}

// --storage-state and --caps storage model session contexts: navigating sets
// a cookie, and browser_storage_state writes cookies loaded plus cookies set.
const storageState = flag('--storage-state');
const state = storageState ? JSON.parse(fs.readFileSync(storageState, 'utf8')) : { cookies: [], origins: [] };
const STORAGE_TOOLS = [
  { name: 'browser_cookie_list', description: 'List cookies', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_storage_state', description: 'Save storage state', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } },
];

const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate to a URL\nSecond line of the description.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_tabs', description: 'List, open or close tabs', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'browser_take_screenshot', description: 'Take a screenshot', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_run_code_unsafe', description: 'Run a Playwright code snippet. Unsafe.', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
  { name: 'browser_close', description: 'Close the page', inputSchema: { type: 'object', properties: {} } },
  ...(flag('--caps') === 'storage' ? STORAGE_TOOLS : []),
];

let url = 'about:blank';
// Held open for the process lifetime, exactly as a real CDP connection is.
const browser = net.connect(Number(endpoint.port), endpoint.hostname);
browser.on('error', () => {});

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    if (process.env.FAKE_INITIALIZE_DELAY_MS) await delay(Number(process.env.FAKE_INITIALIZE_DELAY_MS));
    if (process.env.FAKE_INITIALIZE_ERROR) return sendError(message.id, 'initialize failed');
    return send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-playwright-mcp', version: '1.0.0' },
    });
  }

  if (message.method === 'tools/list') return send(message.id, { tools: TOOLS });

  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params;
    if (name === 'browser_navigate') {
      url = args.url;
      state.cookies.push({ name: 'visited', value: url, domain: new URL(url).hostname, path: '/' });
      if (challenged()) state.cookies.push({ name: 'datadome', value: 'flagged', domain: new URL(url).hostname, path: '/' });
      return send(message.id, { content: [{ type: 'text', text: `navigated to ${url}\n### Page\n- Page URL: ${url}\n- Page Title: Fake page` }] });
    }
    // The controller's challenge probe.
    if (name === 'browser_evaluate') {
      const page = { url, status: challenged() ? 403 : 200, title: challenged() ? 'Access Denied' : 'Fake page', body: 'x'.repeat(200), contentType: 'text/html', markup: '<html></html>' };
      return send(message.id, { content: [{ type: 'text', text: `### Result\n${JSON.stringify(page, null, 2)}\n### Ran Playwright code\n` }] });
    }
    if (name === 'browser_tabs') {
      return send(message.id, { content: [{ type: 'text', text: `### Open tabs\n- 0: (current) [Fake page] (${url})` }] });
    }
    if (name === 'browser_take_screenshot') {
      const file = path.join(outputDir, 'page.png');
      fs.writeFileSync(file, 'not really a png');
      return send(message.id, { content: [{ type: 'text', text: `Saved screenshot to ${file}` }] });
    }
    if (name === 'browser_storage_state' && TOOLS.includes(STORAGE_TOOLS[1])) {
      if (process.env.FAKE_SAVE_HANG) return;
      fs.writeFileSync(path.resolve(args.filename), JSON.stringify(state));
      return send(message.id, { content: [{ type: 'text', text: `- [Storage state](./${path.basename(args.filename)})` }] });
    }
    if (name === 'browser_hang') return;
    if (name === 'browser_fail') return send(message.id, { content: [{ type: 'text', text: 'the page said no' }], isError: true });
    if (name === 'browser_big') {
      const lines = Array.from({ length: args.lines ?? 500 }, (unused, index) => `line ${index + 1}`);
      return send(message.id, { content: [{ type: 'text', text: lines.join('\n') }] });
    }
    if (name === 'browser_slow') {
      await delay(args.ms ?? 200);
      return send(message.id, { content: [{ type: 'text', text: `slept ${args.ms ?? 200}ms` }] });
    }
    if (name === 'browser_crash') return process.exit(1);
    return sendError(message.id, `unknown tool ${name}`);
  }

  return send(message.id, {});
});

// Hosts under blocked.* challenge headless Chrome, which is the browser whose
// contexts get --user-agent, and set a bot-detection cookie.
function challenged() {
  return /(^|\.)blocked\./.test(new URL(url).hostname) && argv.includes('--user-agent');
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
