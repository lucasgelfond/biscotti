import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  opts: { db: Db; sql: ReturnType<typeof sqlBridge>; prompt: string; gate: (req: IncomingMessage, res: ServerResponse) => void; onEvent?: (session: string, event: AgentEvent) => void },
) {
  const { db } = opts;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gate");
    const session = url.searchParams.get("session") || "main";
    if (url.pathname === "/prompt") return void res.end(opts.prompt);
    if (url.pathname === "/event" && req.method === "POST") {
      return void readBody(req).then((body) => (opts.onEvent?.(session, JSON.parse(body)), res.end()), (err) => res.writeHead(400).end(String(err)));
    }
    // pi-durable's storage: its own encrypted database, so nothing the agent sends reaches the vault or memory.
    if (url.pathname === "/sql" && req.method === "POST") {
      return void readBody(req)
        .then(async (body) => res.end(JSON.stringify({ answer: await opts.sql.handle(JSON.parse(body) as SqlRequest) })))
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
  // Only the agent's user (uid 1000, in its own container) may connect.
  await listen(server, `${sockets}/gate.sock`, 1000);
  // An agent still running from before this gate started has the old one's tools.
  await call(`${sockets}/agent.sock`, "POST", "/reload").catch(() => {});

  // One turn of the agent in `session`: its reply, or undefined when the message steered one already underway. The
  // agent may still be starting. `turn.stop` stops the session's turn under way.
  turn.stop = (session: string) => call(`${sockets}/agent.sock`, "POST", "/stop", JSON.stringify({ session })).then(() => {});
  return turn;
  async function turn(message: string, session = "main"): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(await call(`${sockets}/agent.sock`, "POST", "/turn", JSON.stringify({ text: message, session }))).reply;
      } catch (err) {
        if (attempt >= 60 || !/ENOENT|ECONNREFUSED/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

// What the agent is doing in a session, as it goes: a tool call starting, or a message it finished.
export interface AgentEvent {
  type: string;
  toolName?: string;
  args?: unknown;
  message?: { role: string; content: { type: string; text?: string; thinking?: string }[] };
  // A "status" event's: the model, the thinking level, and the context used of its window (tokens).
  model?: string;
  thinking?: string;
  context?: { tokens: number | null; contextWindow: number };
}
