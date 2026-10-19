import { chmodSync, chownSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";

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
