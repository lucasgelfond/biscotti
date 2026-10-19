import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { call, listen, readBody } from "./http.ts";
import { searchableText, type Db } from "./memory.ts";
import { transcripts } from "./schema.ts";

// The gate's side of the main agent (agent.ts): the agent's way in (its model and tools through `gate`, the system
// prompt, its transcript) on a socket only it shares, and each turn sent to the agent's own socket.
export async function connectAgent(sockets: string, opts: { db: Db; prompt: string; gate: (req: IncomingMessage, res: ServerResponse) => void }) {
  const { db } = opts;
  const server = createServer((req, res) => {
    if (req.url === "/prompt") return void res.end(opts.prompt);
    if (req.url !== "/transcript") return opts.gate(req, res);
    if (req.method !== "POST") return void res.end(JSON.stringify(db.select({ entry: transcripts.entry }).from(transcripts).orderBy(transcripts.seq).all().map((r) => r.entry)));
    readBody(req).then(
      (body) => {
        const entries = JSON.parse(body) as FileEntry[];
        if (entries.length) db.insert(transcripts).values(entries.map((entry) => ({ id: entry.id, entry, text: searchableText(entry) }))).onConflictDoNothing().run();
        res.end();
      },
      (err) => res.writeHead(400).end(String(err)),
    );
  });
  // Only the agent's user (uid 1000, in its own container) may connect.
  await listen(server, `${sockets}/gate.sock`, 1000);

  // One turn of the agent: its reply, or undefined when the message steered one already underway. The agent may still
  // be starting.
  return async function turn(message: string): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(await call(`${sockets}/agent.sock`, "POST", "/turn", JSON.stringify({ text: message }))).reply;
      } catch (err) {
        if (attempt >= 60 || !/ENOENT|ECONNREFUSED/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
}
