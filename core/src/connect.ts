import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { TaskRun } from "./agent-tasks.ts";
import type { Board } from "./board.ts";
import { appMethods } from "./plugin.ts";
import { call, listen, readBody } from "./http.ts";
import type { Db } from "./memory.ts";
import type { SqlRequest, sqlBridge } from "./sql-bridge.ts";
import { transcripts } from "./schema.ts";

// The gate's side of the main agent (agent.ts): the agent's way in (its model and tools through `gate`, the system
// prompt, its durable state through `sql`, each session's transcript for memory, what it's doing) on a socket only it
// shares, and each turn sent to the agent's own socket. The main agent has many sessions (conversations): "main" (the owner's texts) or another's number; all
// of them are one memory (memory.ts searches every transcript).
export async function connectAgent(
  sockets: string,
  opts: {
    db: Db;
    sql: ReturnType<typeof sqlBridge>;
    prompt: string;
    // The models' names (main, task, code) -> the provider's ids, for the owner's apps.
    models: Record<string, string>;
    gate: (req: IncomingMessage, res: ServerResponse) => void;
    // pi-env's daemon in a task's VM, for the agent's tools there (an upgrade to /env/<id>, env-pipe.ts).
    env?: (id: number, args: string[], socket: Duplex) => Promise<void>;
    // The tasks' and VMs' board, for the owner's apps (AHP chats, agent.ts).
    board?: Board;
  },
) {
  const { db } = opts;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gate");
    const session = url.searchParams.get("session") || "main";
    if (url.pathname === "/prompt") return void res.end(opts.prompt);
    if (url.pathname === "/models") return void res.end(JSON.stringify(opts.models));
    // pi-durable's storage: its own encrypted database, so nothing the agent sends reaches the vault or memory.
    if (url.pathname === "/sql" && req.method === "POST") {
      return void readBody(req)
        .then(async (body) => res.end(JSON.stringify({ answer: await opts.sql.handle(JSON.parse(body) as SqlRequest) })))
        .catch((err) => res.writeHead(400).end(String((err as Error).message ?? err)));
    }
    // The board as it changes: every row, then each change, a JSON line each.
    if (url.pathname === "/board" && opts.board) {
      const board = opts.board;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (row: Parameters<Parameters<Board["on"]>[0]>[0]) => void res.write(`${JSON.stringify(board.summary(row))}\n`);
      for (const row of board.rows.values()) line(row);
      const off = board.on((row) => line(row));
      return void res.on("close", off);
    }
    // The apps' methods (appMethod), as the agent passes them on (x-biscotti/<name> over AHP).
    if (url.pathname.startsWith("/x/") && req.method === "POST") {
      const method = appMethods.get(decodeURIComponent(url.pathname.slice("/x/".length)));
      if (!method) return void res.writeHead(404).end("no such method");
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      return void readBody(req)
        .then(async (body) => res.end(JSON.stringify((await method(body ? JSON.parse(body) : {}, gone.signal)) ?? null)))
        .catch((err) => res.writeHead(400).end(String((err as Error).message ?? err)));
    }
    if (url.pathname !== "/transcript" || req.method !== "POST") return opts.gate(req, res);
    // What each session said, as text, for memory's search.
    readBody(req).then(
      (body) => {
        const rows = JSON.parse(body) as { id: string; entry: unknown; text: string | null }[];
        if (rows.length) db.insert(transcripts).values(rows.map((r) => ({ id: r.id, entry: r.entry, text: r.text, session }))).onConflictDoNothing().run();
        res.end();
      },
      (err) => res.writeHead(400).end(String(err)),
    );
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    // The agent may hang up while the daemon is being set up.
    socket.on("error", () => socket.destroy());
    const id = Number(new URL(req.url ?? "/", "http://gate").pathname.match(/^\/env\/(\d+)$/)?.[1]);
    if (!id || !opts.env) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const args = String(req.headers["pi-env-arguments"] ?? "").split(" ").filter(Boolean);
    opts.env(id, args, socket).catch((err) => socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${(err as Error).message}`));
  });
  // Only the agent's user (uid 1000, in its own container) may connect.
  await listen(server, `${sockets}/gate.sock`, 1000);
  // An agent still running from before this gate started has the old one's tools.
  await call(`${sockets}/agent.sock`, "POST", "/reload").catch(() => {});

  // One turn of the agent in `session`: its reply, or undefined when the message steered one already underway. The
  // agent may still be starting.
  // A task's run (agent-tasks.ts): what the agent does, as a stream of lines, until it's done or `stopped`.
  turn.task = (run: TaskRun, stopped: AbortSignal) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: `${sockets}/agent.sock`, path: "/task", method: "POST", headers: { "content-type": "application/json" }, agent: false }, (res) =>
        res.statusCode === 200 ? resolve(res) : reject(new Error(`the agent couldn't run the task (${res.statusCode})`)),
      );
      req.on("error", reject);
      stopped.addEventListener("abort", () => req.destroy(stopped.reason as Error), { once: true });
      req.end(JSON.stringify(run));
    });
  return turn;
  // `origin`: who it's from, for the owner's apps (AHP's message kinds): the owner ("user"), or biscotti itself.
  async function turn(message: string, session = "main", origin = "user"): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(await call(`${sockets}/agent.sock`, "POST", "/turn", JSON.stringify({ text: message, session, origin }))).reply;
      } catch (err) {
        if (attempt >= 60 || !/ENOENT|ECONNREFUSED/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
