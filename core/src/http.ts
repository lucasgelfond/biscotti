import { chmodSync, chownSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Duplex, Readable } from "node:stream";

// HTTP between biscotti's processes, over unix sockets.

// Model calls carry screenshots, so they're large, but not unbounded.
const MAX_BODY = 32 * 1024 * 1024;

export async function readBody(stream: AsyncIterable<unknown>, max = MAX_BODY) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error(`request over ${max / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Listens on `path`, readable and writable only by its owner: `uid` when we're root, otherwise us.
export async function listen(server: Server, path: string, uid?: number) {
  // A turn or a tool call can take longer than Node's 5-minute default.
  server.requestTimeout = 0;
  rmSync(path, { force: true });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  if (uid !== undefined && process.getuid?.() === 0) chownSync(path, uid, uid);
  chmodSync(path, 0o600);
}

// A request's answer, its status and body. With no time limit (a tool call may wait minutes on the owner's yes), and on
// a connection each: one kept alive between requests can be closed by the server just as the next is sent (Node's
// lets an idle connection go after 5 s), and that request is lost, e.g. a commit of the agent's storage.
export function answer(socketPath: string, method: string, path: string, body?: string, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers, agent: false }, (res) => void readBody(res).then((text) => resolve({ status: res.statusCode ?? 0, text }), reject));
    req.on("error", reject).end(body);
  });
}

// An answer of 300 or more as an error, its status on it.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The response body, or an HttpError for a status of 300 or more.
export async function call(socketPath: string, method: string, path: string, body?: string, headers?: Record<string, string>) {
  const { status, text } = await answer(socketPath, method, path, body, headers);
  if (status >= 300) throw new HttpError(status, `${path}: ${status} ${text}`);
  return text;
}

// Each line of `input` that's JSON, as it comes (others are skipped).
export function jsonLines(input: Readable, onLine: (value: Record<string, unknown>) => void) {
  return createInterface({ input, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      onLine(JSON.parse(line));
    } catch {}
  });
}

// A WebSocket (or any) upgrade passed through raw to `target` (a unix socket's path, or a host and port), as `path`
// (default: its own) with `host` as its Host header (default: as it came).
export function pipeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: string | { host: string; port: number }, as: { path?: string; host?: string } = {}) {
  const upstream: Socket = typeof target === "string" ? connect(target) : connect(target.port, target.host);
  upstream.once("connect", () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!as.host || req.rawHeaders[i].toLowerCase() !== "host") headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${req.method} ${as.path ?? req.url} HTTP/1.1\r\n${as.host ? `Host: ${as.host}\r\n` : ""}${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// A handler that passes requests through to a server (a unix socket's path, or a host and port; `path` maps the
// request's), streamed both ways: ACP's Streamable HTTP holds a response open for as long as the client follows.
export function passTo(target: string | { host: string; port: number }, path = (url: string) => url) {
  return (req: IncomingMessage, res: ServerResponse) =>
    new Promise<void>((resolve) => {
      const to = typeof target === "string" ? { socketPath: target, headers: req.headers } : { ...target, headers: { ...req.headers, host: `${target.host}:${target.port}` } };
      const upstream = request({ ...to, method: req.method, path: path(req.url ?? "/"), agent: false }, (answer) => {
        // Sent at once: an event stream (text/event-stream) may say nothing for a while, and Node holds headers back
        // until the body's first bytes.
        res.writeHead(answer.statusCode ?? 502, answer.headers).flushHeaders();
        answer.pipe(res);
        answer.on("end", resolve).on("error", () => (res.destroy(), resolve()));
      });
      upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end(), resolve()));
      // The client gone, so is the request upstream.
      res.on("close", () => (upstream.destroy(), resolve()));
      req.pipe(upstream);
    });
}

// The owner's API, for their apps: the routes plugins add (Context.route), on API_PORT on localhost. `tailscale serve`
// publishes it on the tailnet (nix/setup.nix), which names the person on each request (Tailscale-User-Login). Only the
// owner's login (API_OWNER, e.g. you@github) may use it; without API_OWNER, anyone on the tailnet signed in as a person
// (not a tagged machine) may.
export function ownerApi(port = Number(process.env.API_PORT ?? 7700)) {
  const owner = (req: IncomingMessage) => {
    const login = req.headers["tailscale-user-login"];
    return Boolean(login) && (!process.env.API_OWNER || login === process.env.API_OWNER);
  };
  const routes: [string, (req: IncomingMessage, res: ServerResponse) => unknown][] = [];
  const server = createServer(async (req, res) => {
    if (!owner(req)) return void res.writeHead(403).end();
    const path = new URL(req.url ?? "/", "http://api").pathname;
    const route = routes.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (!route) return void res.writeHead(404).end();
    try {
      await route[1](req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  // WebSocket upgrades (the Agent Host Protocol at /ahp, the Agent Client Protocol at /acp) passed through, raw, to a
  // unix socket.
  const upgrades: [string, string][] = [];
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    const target = upgrades.find(([prefix]) => new URL(req.url ?? "/", "http://api").pathname === prefix)?.[1];
    if (!owner(req) || !target) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    pipeUpgrade(req, socket, head, target);
  });
  return {
    route: (prefix: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown) => void routes.push([prefix, handler]),
    upgrade: (prefix: string, socketPath: string) => void upgrades.push([prefix, socketPath]),
    // On API_PORT, unless it's 0 (tests and the dev host reach the agent's socket directly). A prompt waits for its
    // task's report, often longer than Node's 5-minute default.
    listen: () => (port ? new Promise<Server>((resolve) => ((server.requestTimeout = 0), server.listen(port, "127.0.0.1", () => resolve(server)))) : undefined),
  };
}
