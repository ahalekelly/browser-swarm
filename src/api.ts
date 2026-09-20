// Talking to the controller from wherever an agent runs. Outside a sandbox
// that is a plain loopback request. Inside Claude Code's Linux bash sandbox,
// loopback is a separate network namespace, so the request goes through the
// sandbox's HTTP proxy, which is the only path to the host's 127.0.0.1.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { PORT, SERVICE_HINT, TOKEN_FILE } from './config.ts';

const CONNECT_DEADLINE_MS = 10_000;
// Longer than the controller's own 120s call deadline, plus room for a call
// that waits its turn behind another on the same context.
const TOTAL_DEADLINE_MS = 300_000;
const HOST = `127.0.0.1:${PORT}`;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Proxy = { host: string; port: number; authorization: string; label: string };

export async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const proxy = sandboxProxy();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    host: HOST,
    authorization: `Bearer ${token()}`,
  };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (proxy) headers['proxy-authorization'] = proxy.authorization;

  const response = await new Promise<{ status: number; text: string }>((resolveResponse, rejectResponse) => {
    const outgoing = httpRequest({
      host: proxy ? proxy.host : '127.0.0.1',
      port: proxy ? proxy.port : PORT,
      // Proxies need the absolute form; the controller sees the path either way.
      path: proxy ? `http://${HOST}${path}` : path,
      method,
      headers,
      agent: false,
    }, (incoming) => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { text += chunk; });
      incoming.on('end', () => resolveResponse({ status: incoming.statusCode ?? 0, text }));
    });
    // The connect deadline covers only establishing the connection: a browser
    // call can legitimately go minutes without a byte on the wire.
    outgoing.once('socket', (socket) => {
      socket.setTimeout(CONNECT_DEADLINE_MS, () => outgoing.destroy(new Error(`no connection within ${CONNECT_DEADLINE_MS / 1000}s`)));
      socket.once('connect', () => socket.setTimeout(0));
    });
    outgoing.once('error', rejectResponse);
    const total = setTimeout(() => outgoing.destroy(new Error(`the controller did not finish within ${TOTAL_DEADLINE_MS / 1000}s`)), TOTAL_DEADLINE_MS);
    outgoing.once('close', () => clearTimeout(total));
    outgoing.end(payload);
  }).catch((error) => {
    throw new ApiError(0, transportMessage(error, proxy));
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new ApiError(response.status, `controller returned ${response.status} with a non-JSON body: ${response.text.slice(0, 200)}`);
  }
  if (response.status !== 200) throw new ApiError(response.status, String(parsed.error ?? response.text));
  return parsed;
}

// http_proxy alone proves nothing — a corporate proxy sets it too, and
// following that one would target the proxy machine's loopback.
// CLAUDE_CODE_HOST_HTTP_PROXY_PORT is set only by the Claude Code sandbox,
// whose proxy forwards to this host's 127.0.0.1 listeners.
function sandboxProxy(): Proxy | undefined {
  if (!process.env.CLAUDE_CODE_HOST_HTTP_PROXY_PORT) return undefined;
  const raw = process.env.http_proxy ?? process.env.HTTP_PROXY;
  if (!raw) return undefined;
  const url = new URL(raw);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port: Number(url.port || 80),
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
    label: `${url.protocol}//${url.hostname}:${url.port || 80}`,
  };
}

// Proxy credentials never reach the controller and never reach an error
// message; only the proxy's address does.
function transportMessage(error: unknown, proxy: Proxy | undefined): string {
  const detail = error instanceof Error ? error.message : String(error);
  const via = proxy ? ` via the sandbox proxy ${proxy.label}` : '';
  return `cannot reach the BrowserSwarm controller at ${HOST}${via}: ${detail}. Start it with \`${SERVICE_HINT}\` from an unsandboxed shell.`;
}

function token(): string {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new ApiError(0, `no controller token at ${TOKEN_FILE} — the controller has never run here. Start it with \`${SERVICE_HINT}\` from an unsandboxed shell.`);
  }
}
