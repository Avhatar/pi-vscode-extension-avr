import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { parseClientMessage, type ServerMessage } from './protocol.js';

const HOST = '127.0.0.1';
const AUTH_TIMEOUT_MS = 5_000;
const MAX_PROMPT_LENGTH = 100_000;

const options = parseArguments(process.argv.slice(2));
const cwd = resolve(options.cwd);
await assertDirectory(cwd);
process.chdir(cwd);

console.log(`[crt-spike] Initializing Pi session in ${cwd}`);
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
await resourceLoader.reload();

const { session, modelFallbackMessage } = await createAgentSession({
  cwd,
  authStorage,
  modelRegistry,
  resourceLoader,
  sessionManager: SessionManager.create(cwd),
});

if (modelFallbackMessage) {
  console.warn(`[crt-spike] Model fallback: ${modelFallbackMessage}`);
}

const token = randomBytes(32).toString('base64url');
const tokenDigest = digest(token);
const authenticatedClients = new WeakSet<WebSocket>();
let activeClient: WebSocket | undefined;
const distDir = dirname(fileURLToPath(import.meta.url));
const staticFiles = await loadStaticFiles(distDir);
let expectedOrigin = '';

const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    respond(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    return;
  }
  if (!expectedOrigin || request.headers.host !== new URL(expectedOrigin).host) {
    respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  const url = new URL(request.url ?? '/', expectedOrigin);
  const asset = staticFiles.get(url.pathname);
  if (!asset) {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': asset.contentType,
    'Content-Length': asset.body.byteLength,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      `connect-src 'self' ${expectedOrigin.replace('http:', 'ws:')}`,
      "font-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(asset.body);
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

server.on('upgrade', (request, socket, head) => {
  if (request.headers.origin !== expectedOrigin || request.url !== '/') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(request, socket, head, (client) => {
    webSockets.emit('connection', client, request);
  });
});

webSockets.on('connection', (client) => {
  const authTimer = setTimeout(() => client.close(1008, 'Authentication timeout'), AUTH_TIMEOUT_MS);

  client.on('message', (raw, isBinary) => {
    if (isBinary) {
      client.close(1003, 'Text messages only');
      return;
    }

    const message = parseClientMessage(rawToString(raw));
    if (!message) {
      send(client, { type: 'error', message: 'Invalid client message.' });
      return;
    }

    if (!authenticatedClients.has(client)) {
      if (message.type !== 'auth' || !matchesToken(message.token, tokenDigest)) {
        client.close(1008, 'Authentication failed');
        return;
      }

      if (activeClient?.readyState === WebSocket.OPEN && activeClient !== client) {
        client.close(1008, 'Another CRT client is already connected');
        return;
      }

      clearTimeout(authTimer);
      activeClient = client;
      authenticatedClients.add(client);
      send(client, { type: 'authenticated' });
      sendReady(client);
      return;
    }

    if (message.type === 'prompt') {
      const text = message.text.trim();
      if (!text) {
        send(client, { type: 'error', message: 'Prompt cannot be empty.' });
        return;
      }
      if (text.length > MAX_PROMPT_LENGTH) {
        send(client, { type: 'error', message: `Prompt exceeds ${MAX_PROMPT_LENGTH} characters.` });
        return;
      }
      if (session.isStreaming) {
        send(client, { type: 'error', message: 'The spike accepts one prompt at a time. Abort or wait for completion.' });
        return;
      }

      send(client, { type: 'prompt_accepted' });
      void session.prompt(text).catch((error: unknown) => {
        broadcast({ type: 'error', message: formatError(error) });
      });
      return;
    }

    if (message.type === 'abort') {
      void session.abort()
        .then(() => send(client, { type: 'abort_accepted' }))
        .catch((error: unknown) => {
          send(client, { type: 'error', message: formatError(error) });
        });
      return;
    }

    send(client, { type: 'error', message: 'Authenticate only once per connection.' });
  });

  client.on('close', () => {
    clearTimeout(authTimer);
    if (activeClient === client) activeClient = undefined;
  });
});

const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case 'agent_start':
      broadcast({ type: 'agent_start' });
      break;
    case 'agent_settled':
      broadcast({ type: 'agent_settled' });
      break;
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        broadcast({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
      } else if (event.assistantMessageEvent.type === 'thinking_delta') {
        broadcast({ type: 'thinking_delta', delta: event.assistantMessageEvent.delta });
      }
      break;
    case 'tool_execution_start':
      broadcast({
        type: 'tool_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case 'tool_execution_end':
      broadcast({
        type: 'tool_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
      break;
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(options.port, HOST, () => {
    server.off('error', rejectListen);
    resolveListen();
  });
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to resolve listening address.');
expectedOrigin = `http://${HOST}:${address.port}`;
const launchUrl = `${expectedOrigin}/#token=${encodeURIComponent(token)}`;

console.log(`[crt-spike] Ready on ${expectedOrigin}`);
console.log(`[crt-spike] Workspace: ${cwd}`);
console.log(`[crt-spike] Open this per-launch local URL: ${launchUrl}`);
console.log('[crt-spike] This experimental host runs tools with your user account permissions.');

if (options.openBrowser) openBrowser(launchUrl);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[crt-spike] ${signal}; shutting down...`);
  unsubscribe();
  for (const client of webSockets.clients) client.close(1001, 'Host shutdown');
  webSockets.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  session.dispose();
}

process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));

function sendReady(client: WebSocket): void {
  const model = session.model;
  send(client, {
    type: 'ready',
    cwd,
    model: model ? `${model.provider}/${model.id}` : undefined,
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
  });
}

function broadcast(message: ServerMessage): void {
  for (const client of webSockets.clients) {
    if (authenticatedClients.has(client)) send(client, message);
  }
}

function send(client: WebSocket, message: ServerMessage): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function matchesToken(candidate: string, expectedDigest: Buffer): boolean {
  const candidateDigest = digest(candidate);
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return raw.toString('utf8');
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function loadStaticFiles(root: string): Promise<Map<string, { contentType: string; body: Buffer }>> {
  const definitions = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/app.js.map', 'app.js.map', 'application/json; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/assets/VT323-Regular.ttf', 'assets/VT323-Regular.ttf', 'font/ttf'],
    ['/assets/OFL-VT323.txt', 'assets/OFL-VT323.txt', 'text/plain; charset=utf-8'],
  ] as const;
  const files = new Map<string, { contentType: string; body: Buffer }>();
  for (const [urlPath, fileName, contentType] of definitions) {
    files.set(urlPath, { contentType, body: await readFile(resolve(root, fileName)) });
  }
  return files;
}

async function assertDirectory(path: string): Promise<void> {
  await access(path);
  if (!(await stat(path)).isDirectory()) throw new Error(`Workspace is not a directory: ${path}`);
}

function parseArguments(args: string[]): { cwd: string; port: number; openBrowser: boolean } {
  let cwd = process.cwd();
  let port = 0;
  let openBrowser = true;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error('--cwd requires a path.');
      cwd = value;
    } else if (argument === '--port') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error('--port requires an integer between 0 and 65535.');
      }
      port = value;
    } else if (argument === '--no-open') {
      openBrowser = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { cwd, port, openBrowser };
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32'
    ? { executable: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : { executable: 'xdg-open', args: [url] };

  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => console.warn(`[crt-spike] Could not open browser: ${error.message}`));
  child.unref();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
