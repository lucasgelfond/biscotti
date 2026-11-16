import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { type CancellationToken, CancellationTokenSource, createMessageConnection, type MessageConnection, ResponseError, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node.js";
import { listen } from "./http.ts";
import type { Db } from "./memory.ts";
import { appMethods } from "./plugin.ts";
import { transcripts } from "./schema.ts";

// The gate's side of the main agent (agent.ts), on two sockets only the agent's user may open. gate.sock: its model
// calls and the gate's tools (gate.handle, as task VMs have them), and the raw pipes plugins add (pi-env into a task's
// VM). link.sock: one JSON-RPC connection the agent opens and starts with a hello (the system prompt, the models'
// names, the apps' methods and the plugins' agent sides), then says it's ready; on it go the turns, each session's
// transcript for memory, the apps' methods, and plugins' requests both ways. A new gate is a new connection, so the
// agent says hello again and takes up its tools and prompt.

export interface AgentLink {
  // A request of the agent, sent once it's ready (it may be starting, or back after a restart); `signal` cancels it.
  // Rejects when the agent goes away first.
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  // A notification for the agent, dropped if it isn't there.
  notify(method: string, params?: unknown): void;
  // The agent's requests of a plugin (its agent side's).
  handle(method: string, fn: (params: any, signal: AbortSignal) => unknown): void;
  // Each time the agent is ready.
  onReady(fn: () => void): void;
  // A raw upgrade on gate.sock, its path starting with `prefix`.
  upgrade(prefix: string, fn: (req: IncomingMessage, socket: Duplex) => void): void;
}

export const signalOf = (token: CancellationToken) => {
  const aborted = new AbortController();
  token.onCancellationRequested(() => aborted.abort());
  return aborted.signal;
};

export async function connectAgent(
  sockets: string,
  opts: {
    db: Db;
    prompt: string;
    // The models' names (main, task, code) -> the provider's ids, for the owner's apps.
    models: Record<string, string>;
    // The plugins' agent sides (Plugin.agent).
    plugins: string[];
    gate: (req: IncomingMessage, res: ServerResponse) => void;
  },
) {
  const handlers = new Map<string, (params: any, signal: AbortSignal) => unknown>();
  const readied: (() => void)[] = [];
  const upgrades: [string, (req: IncomingMessage, socket: Duplex) => void][] = [];
  let ready = Promise.withResolvers<MessageConnection>();
  let current: MessageConnection | undefined;

  handlers.set("hello", () => ({ prompt: opts.prompt, models: opts.models, methods: [...appMethods.keys()], plugins: opts.plugins }));
  handlers.set("method", ({ name, params }: { name: string; params?: Record<string, unknown> }, signal) => {
    const method = appMethods.get(name);
    if (!method) throw new ResponseError(-32601, `no method ${name}`);
    return method(params ?? {}, signal);
  });

  const server = createServer(opts.gate);
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    // The agent may hang up while a pipe is being set up.
    socket.on("error", () => socket.destroy());
    const upgrade = upgrades.find(([prefix]) => req.url?.startsWith(prefix))?.[1];
    if (!upgrade) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    upgrade(req, socket);
  });
  const connections = new Set<Socket>();
  const link = createNetServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    conn.onRequest((method, params, token) => {
      const handler = handlers.get(method);
      if (!handler) throw new ResponseError(-32601, `no method ${method}`);
      return handler(params, signalOf(token));
    });
    conn.onNotification("transcript", ({ session, rows }: { session: string; rows: { id: string; entry: unknown; text: string | null }[] }) => {
      if (rows.length) opts.db.insert(transcripts).values(rows.map((r) => ({ ...r, session }))).onConflictDoNothing().run();
    });
    conn.onNotification("ready", () => {
      current = conn;
      ready.resolve(conn);
      for (const fn of readied) fn();
    });
    conn.onClose(() => {
      // Its requests still waiting are rejected.
      conn.dispose();
      if (current !== conn) return;
      current = undefined;
      ready = Promise.withResolvers();
    });
    socket.on("error", () => socket.destroy());
    conn.listen();
  });

  const agent: AgentLink = {
    async request<T>(method: string, params?: unknown, signal?: AbortSignal) {
      const conn = await ready.promise;
      signal?.throwIfAborted();
      const cancel = new CancellationTokenSource();
      signal?.addEventListener("abort", () => cancel.cancel(), { once: true });
      return conn.sendRequest<T>(method, params, cancel.token).catch((err: Error) => {
        if (signal?.aborted) throw signal.reason;
        throw current === conn ? err : new Error("the agent stopped in the middle of it (it restarted)");
      });
    },
    notify: (method, params) => void current?.sendNotification(method, params),
    handle: (method, fn) => void handlers.set(method, fn),
    onReady: (fn) => void readied.push(fn),
    upgrade: (prefix, fn) => void upgrades.push([prefix, fn]),
  };

  // One turn in `session`: the agent's reply, or undefined when the message steered one already under way. `origin`:
  // who it's from, for the owner's apps (AHP's message kinds): the owner ("user"), or biscotti itself.
  const turn = async (message: string, session = "main", origin = "user") => (await agent.request<{ reply?: string }>("turn", { text: message, session, origin })).reply;
  // Listening, once the plugins have added their tools and methods: an agent already running says hello at once.
  const open = async () => {
    await listen(server, `${sockets}/gate.sock`, 1000);
    await listen(link, `${sockets}/link.sock`, 1000);
  };
  // Stopped (a test's gate making way for the next, as a restart does): the agent's link ends.
  const close = () => {
    server.close();
    link.close();
    for (const socket of connections) socket.destroy();
  };
  return { agent, turn, open, close };
}
