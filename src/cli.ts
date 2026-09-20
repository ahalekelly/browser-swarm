// `swarm`: the whole agent-facing surface. Every verb is one stateless HTTP
// call to the controller, so nothing runs inside the agent's harness.
import { readFileSync } from 'node:fs';
import { api, ApiError } from './api.ts';
import { serveMcp } from './mcp.ts';

const ID = /^c[0-9a-f]{16}$/;
const PREVIEW_LINES = 100;

const USAGE = `usage:
  swarm open [chromium|firefox]   open a context; prints its id
  swarm ls                        list open contexts
  swarm status                    browsers, contexts, last crash
  swarm <id> tools                available tools
  swarm <id> help <tool>          one tool's schema
  swarm <id> <tool> [json|-]      call a tool ("-" reads JSON arguments from stdin)
  swarm <id> close                close a context`;

class UsageError extends Error {}

await main();

async function main(): Promise<void> {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) return fail(2, `${error.message}\n\n${USAGE}`);
    if (error instanceof ApiError) return fail(error.status === 404 || error.status === 410 ? 4 : 3, error.message);
    throw error;
  }
}

async function run(args: string[]): Promise<void> {
  const [first, ...rest] = args;
  if (first === undefined) throw new UsageError('no command');
  if (!ID.test(first)) return await command(first, rest);

  const [verb, ...verbArgs] = rest;
  if (verb === undefined) throw new UsageError(`${first}: no tool or verb`);
  if (verb === 'close') {
    const result = await api('DELETE', `/contexts/${first}`);
    console.error(result.closed ? `closed ${first}` : `${first} was already closed`);
    return;
  }
  if (verb === 'tools') return await printTools(first);
  if (verb === 'help') {
    if (verbArgs.length !== 1) throw new UsageError('help takes one tool name');
    return await printToolHelp(first, verbArgs[0]);
  }
  return await callTool(first, verb, verbArgs);
}

async function command(verb: string, args: string[]): Promise<void> {
  if (verb === 'mcp') {
    const backend = args[0];
    if (backend !== 'chromium' && backend !== 'firefox') throw new UsageError('mcp takes chromium or firefox');
    return await serveMcp(backend);
  }
  if (verb === 'open') {
    const backend = args[0] ?? 'chromium';
    if (backend !== 'chromium' && backend !== 'firefox') throw new UsageError(`unknown backend ${backend}`);
    const result = await api('POST', '/contexts', { backend });
    console.log(result.id);
    console.error(`output: ${result.outputDir}`);
    return;
  }
  if (verb === 'ls') {
    const { contexts } = await api('GET', '/contexts') as { contexts: ContextInfo[] };
    if (contexts.length === 0) return console.log('no open contexts');
    for (const context of contexts) {
      const state = context.busy ? 'busy' : `idle ${context.idleSeconds}s`;
      console.log(`${context.id}  ${context.backend}  age ${context.ageSeconds}s  ${state}  ${context.outputDir}`);
      for (const page of context.pages ?? []) console.log(`    ${page}`);
    }
    return;
  }
  if (verb === 'status') {
    const status = await api('GET', '/status') as { port: number; contexts: number; browsers: BrowserInfo[] };
    console.log(`controller on 127.0.0.1:${status.port}, ${status.contexts} context${status.contexts === 1 ? '' : 's'}`);
    if (status.browsers.length === 0) console.log('no browser started yet');
    for (const browser of status.browsers) {
      console.log(browser.running
        ? `${browser.backend}: pid ${browser.pid}, up ${browser.upSeconds}s, ${browser.contexts} context${browser.contexts === 1 ? '' : 's'}`
        : `${browser.backend}: stopped`);
      if (browser.lastCrash) console.log(`  last crash: ${browser.lastCrash}`);
    }
    return;
  }
  throw new UsageError(`unknown command ${verb}`);
}

async function printTools(id: string): Promise<void> {
  const { tools } = await api('POST', `/contexts/${id}/tools`) as { tools: Tool[] };
  for (const tool of tools) {
    console.log(`${bare(tool.name)}  ${(tool.description ?? '').split('\n')[0]}`);
  }
  console.log(`\nswarm ${id} help <tool> prints a tool's arguments.`);
}

async function printToolHelp(id: string, name: string): Promise<void> {
  const { tools } = await api('POST', `/contexts/${id}/tools`) as { tools: Tool[] };
  const tool = tools.find((candidate) => candidate.name === full(name));
  if (!tool) throw new ApiError(400, `no tool ${bare(name)}; run \`swarm ${id} tools\``);
  console.log(`${bare(tool.name)}\n${tool.description ?? ''}\n`);
  console.log(JSON.stringify(tool.inputSchema, null, 2));
}

async function callTool(id: string, name: string, args: string[]): Promise<void> {
  if (args.length > 1) throw new UsageError('a tool call takes at most one JSON argument object');
  const source = args[0] === '-' ? readFileSync(0, 'utf8') : args[0];
  let parsed: unknown = {};
  if (source !== undefined && source.trim() !== '') {
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new UsageError(`arguments are not valid JSON: ${(error as Error).message}`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('arguments must be a JSON object');
  }

  const result = await api('POST', `/contexts/${id}/call`, { name: full(name), arguments: parsed }) as CallResult;
  const lines = result.text.split('\n');
  if (result.savedPath) {
    console.log(lines.slice(0, PREVIEW_LINES).join('\n'));
    console.log(`\n[${lines.length} lines; first ${PREVIEW_LINES} shown, full text at ${result.savedPath}]`);
  } else {
    console.log(result.text);
  }
  if (result.isError) process.exitCode = 1;
}

type ContextInfo = { id: string; backend: string; ageSeconds: number; idleSeconds: number; busy: boolean; outputDir: string; pages: string[] | null };
type BrowserInfo = { backend: string; running: boolean; pid: number | null; upSeconds: number | null; contexts: number; lastCrash: string | null };
type Tool = { name: string; description?: string; inputSchema: unknown };
type CallResult = { text: string; isError: boolean; outputDir: string; savedPath?: string };

function bare(name: string): string {
  return name.replace(/^browser_/, '');
}

function full(name: string): string {
  return `browser_${bare(name)}`;
}

function fail(code: number, text: string): void {
  console.error(text);
  process.exitCode = code;
}
