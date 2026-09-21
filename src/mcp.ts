// Codex's command sandbox blocks all network access, so its agents cannot run
// the CLI. `swarm mcp <backend>` is the bridge: a stdio MCP server that owns
// one controller context and forwards tool calls to it over the same HTTP API.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './api.ts';
import { IDLE_MS, ROOT } from './config.ts';

const CLOSE_TOOL = {
  name: 'browser_close',
  description: 'Permanently close this MCP session’s browser context and release its tabs. Call it when the browser work is done; further browser work needs a fresh browser-swarm agent.',
  inputSchema: { type: 'object', properties: {} },
};

export async function serveMcp(backend: 'chromium' | 'firefox'): Promise<void> {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  let id: string;
  let outputDir: string;
  try {
    const opened = await api('POST', '/contexts', { backend });
    id = opened.id as string;
    outputDir = opened.outputDir as string;
  } catch (error) {
    const failed = new Server({ name: 'browser-swarm', version }, { capabilities: { tools: {} } });
    return await serveStartupError(failed, error instanceof Error ? error.message : String(error));
  }
  console.error(`BrowserSwarm context ${id}, output ${outputDir}`);
  // Server instructions are the one channel that reaches the agent without a
  // tool call, and the output dir is what every artifact link is relative to.
  const server = new Server({ name: 'browser-swarm', version }, {
    capabilities: { tools: {} },
    instructions: `Downloads, screenshots and scratch files land in ${outputDir}. A result links an artifact relative to that directory, so resolve the link against it before reading the file.`,
  });

  let closed = false;
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    await api('DELETE', `/contexts/${id}`).catch(() => {});
  };
  // The lease starts when the session is ready, is suspended while a call is
  // in flight, and restarts when one finishes.
  const renew = (): void => {
    clearTimeout(idleTimer);
    if (inFlight > 0 || closed) return;
    idleTimer = setTimeout(() => {
      console.error('BrowserSwarm closed this MCP session after 5 minutes without activity. Relaunch the browser agent to use browser tools again.');
      void close().then(() => process.exit(75));
    }, IDLE_MS);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    inFlight += 1;
    try {
      const { tools } = await api('POST', `/contexts/${id}/tools`) as { tools: unknown[] };
      return { tools: [...tools, CLOSE_TOOL] };
    } finally {
      inFlight -= 1;
      renew();
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    inFlight += 1;
    try {
      if (request.params.name === CLOSE_TOOL.name) {
        await close();
        return { content: [{ type: 'text', text: `Closed browser context ${id}.` }] };
      }
      if (closed) throw new Error('This MCP session is closed. Ask the orchestrator to spawn a fresh browser-swarm agent for further browser work; resuming this agent does not create a new context.');
      const result = await api('POST', `/contexts/${id}/call`, {
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      }) as { text: string; isError: boolean; savedPath?: string };
      const text = result.savedPath ? `${result.text}\n\n[full text also saved at ${result.savedPath}]` : result.text;
      return { content: [{ type: 'text', text }], isError: result.isError };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      inFlight -= 1;
      renew();
    }
  });

  await server.connect(new StdioServerTransport());
  renew();

  const stop = (code: number) => { void close().then(() => process.exit(code)); };
  process.stdin.once('end', () => stop(0));
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  await new Promise(() => {});
}

// A session that never got a context still has to speak MCP, or the harness
// reports a connection failure instead of the reason the browser is missing.
async function serveStartupError(server: Server, detail: string): Promise<void> {
  const text = `BrowserSwarm could not attach browser tools to this session. Error: ${detail}. Stop and report this error to the orchestrator; do not work around it with other tools.`;
  console.error(`ERROR: ${detail}`);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'browser_swarm_error', description: text, inputSchema: { type: 'object', properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text }], isError: true }));
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolveEnd) => {
    process.stdin.once('end', resolveEnd);
    process.once('SIGINT', resolveEnd);
    process.once('SIGTERM', resolveEnd);
  });
  process.exit(1);
}
