// `swarm`: the whole agent-facing surface. Every verb is one stateless HTTP
// call to the controller, so nothing runs inside the agent's harness.
import { readFileSync } from 'node:fs';
import { api, ApiError } from './api.ts';
import { serveMcp } from './mcp.ts';

const ID = /^c[0-9a-f]{16}$/;
const PREVIEW_LINES = 100;
// Comfortably inside the controller's five-minute idle lease.
const LOGIN_RENEW_MS = 60_000;

const USAGE = `usage:
  swarm open [chromium|firefox] [--session <name>]
                                  open a context, optionally with a saved
                                  session; prints its id
  swarm login <session> <url>     open <url> in a session context for a human
                                  to log in; Enter saves the session
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
    // 400 is the controller rejecting what the caller asked for, which is a
    // usage mistake; 404 and 410 mean the context is gone.
    if (error instanceof ApiError) return fail(exitFor(error.status), error.message);
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
    console.error(result.closed ? `closed ${first}${result.session ? `, saved session ${result.session}` : ''}` : `${first} was already closed`);
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
    const rest = [...args];
    const flag = rest.indexOf('--session');
    const session = flag === -1 ? undefined : rest.splice(flag, 2)[1];
    if (flag !== -1 && session === undefined) throw new UsageError('--session takes a name');
    const [backend = 'chromium', ...extra] = rest;
    if (backend !== 'chromium' && backend !== 'firefox') throw new UsageError(`unknown backend ${backend}`);
    if (extra.length > 0) throw new UsageError(`unexpected ${extra.join(' ')}`);
    const result = await api('POST', '/contexts', { backend, session }) as Opened;
    console.log(result.id);
    console.error(`output: ${result.outputDir}`);
    if (result.session) console.error(`session: ${result.session.name}${result.session.existing ? '' : ' (new, starts logged out)'}`);
    return;
  }
  if (verb === 'login') {
    if (args.length !== 2) throw new UsageError('login takes a session name and a URL');
    return await login(args[0], args[1]);
  }
  if (verb === 'ls') {
    const { contexts } = await api('GET', '/contexts') as { contexts: ContextInfo[] };
    if (contexts.length === 0) return console.log('no open contexts');
    for (const context of contexts) {
      const state = context.busy ? 'busy' : `idle ${context.idleSeconds}s`;
      const session = context.session ? `  session ${context.session}` : '';
      console.log(`${context.id}  ${context.backend}${session}  age ${context.ageSeconds}s  ${state}  ${context.outputDir}`);
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

// A human logs in through DevTools, which renews no lease, so this keeps the
// context alive until they press Enter and then closes it, which saves it.
async function login(session: string, url: string): Promise<void> {
  if (!process.stdin.isTTY) throw new UsageError('login waits for Enter on a terminal; over SSH, pass -t');
  const { id } = await api('POST', '/contexts', { backend: 'chromium', session }) as Opened;
  const navigated = await api('POST', `/contexts/${id}/call`, { name: 'browser_navigate', arguments: { url } }) as CallResult;
  if (navigated.isError) {
    await api('DELETE', `/contexts/${id}`);
    return fail(1, `could not open ${url}: ${navigated.text}`);
  }
  console.error(`Context ${id} is on ${url}. Open it in chrome://inspect (see the BrowserSwarm README), log in, then press Enter here to save session ${session}.`);
  const renew = setInterval(() => {
    api('POST', `/contexts/${id}/call`, { name: 'browser_tabs', arguments: { action: 'list' } }).catch((error: ApiError) => {
      fail(exitFor(error.status), `${error.message}\nSession ${session} was not saved; run login again.`);
      process.exit();
    });
  }, LOGIN_RENEW_MS);
  await new Promise((resolveEnter) => process.stdin.once('data', resolveEnter));
  clearInterval(renew);
  process.stdin.destroy();
  await api('DELETE', `/contexts/${id}`);
  console.error(`saved session ${session}`);
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
  if (!tool) throw new UsageError(`no tool ${bare(name)}; run \`swarm ${id} tools\``);
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

type Opened = { id: string; outputDir: string; session?: { name: string; existing: boolean } };
type ContextInfo = { id: string; backend: string; session: string | null; ageSeconds: number; idleSeconds: number; busy: boolean; outputDir: string; pages: string[] | null };
type BrowserInfo = { backend: string; running: boolean; pid: number | null; upSeconds: number | null; contexts: number; lastCrash: string | null };
type Tool = { name: string; description?: string; inputSchema: unknown };
type CallResult = { text: string; isError: boolean; outputDir: string; savedPath?: string };

function exitFor(status: number): number {
  if (status === 404 || status === 410) return 4;
  return status === 400 ? 2 : 3;
}

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
