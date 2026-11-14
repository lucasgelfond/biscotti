import { chmodSync, chownSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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
  rmSync(path, { force: true });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  if (uid !== undefined && process.getuid?.() === 0) chownSync(path, uid, uid);
  chmodSync(path, 0o600);
}

// The response body, or an error for a status of 300 or more.
export function call(socketPath: string, method: string, path: string, body?: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      readBody(res).then((text) => (res.statusCode! < 300 ? resolve(text) : reject(new Error(`${path}: ${res.statusCode} ${text}`))), reject);
    });
    req.on("error", reject).end(body);
  });
}

// The owner's API, for their apps: the routes plugins add (Context.route), on API_PORT on localhost. `tailscale serve`
// publishes it on the tailnet (nix/setup.nix), which names the person on each request (Tailscale-User-Login). Only the
// owner's login (API_OWNER, e.g. you@github) may use it; without API_OWNER, anyone on the tailnet signed in as a person
// (not a tagged machine) may.
export function ownerApi(port = Number(process.env.API_PORT ?? 7700)) {
  const routes: [string, (req: IncomingMessage, res: ServerResponse) => unknown][] = [];
  const server = createServer(async (req, res) => {
    const login = req.headers["tailscale-user-login"];
    const owner = process.env.API_OWNER;
    if (!login || (owner && login !== owner)) return void res.writeHead(403).end();
    const path = new URL(req.url ?? "/", "http://api").pathname;
    const route = routes.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (!route) return void res.writeHead(404).end();
    try {
      await route[1](req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  return {
    route: (prefix: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown) => void routes.push([prefix, handler]),
    // Only once a plugin has added a route.
    listen: () => (routes.length && port ? new Promise<Server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server))) : undefined),
  };
}
