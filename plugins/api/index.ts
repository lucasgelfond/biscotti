import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { taskEvents, type Context, type Plugin, type TaskEvent, type Vms } from "@biscotti/core";
import { sql } from "drizzle-orm";

// The owner's apps (apps/ios, and Concourse in the dotfiles) reach biscotti as an ACP agent
// (agentclientprotocol.com), over its Streamable HTTP transport at /acp on the owner's API. Each task, and each of a
// plugin's VMs (ssh-vms), is a session, numbered as biscotti numbers them:
//
//   session/list     the board, newest first; each session's _meta.biscotti says what it is (Summary)
//   session/new      a number for a task to come; its first prompt is the goal (its report goes to the main agent too).
//                    _meta.biscotti.display: "mobile" (a phone-shaped desktop: the iPhone app's) or "desktop"
//   session/prompt   the goal, or the owner's message for a running or kept task; answered when the task reports
//   session/cancel   stop it (its VM is kept)
//   session/load     its history replayed; session/resume and session/close are accepted (every connection follows all)
//   session/delete   its kept VM deleted, and its row
//
// What a task does comes as session/update: the goal and the owner's messages (user_message_chunk), each tool call
// (tool_call), what it says and its report, with its screenshot (agent_message_chunk), and session_info_update as its
// status changes. Every connection is sent every session's updates (one owner, a few devices); over HTTP they reach
// only the sessions whose streams it opened, so each change also comes as _biscotti/session {session: SessionInfo} on
// the connection's own stream, for a board without polling. Plugins add methods of
// their own (`extension`), named _biscotti/…; this one has _biscotti/watch {sessionId} -> {url}, the live desktop.

// What the board knows of a session (in _meta.biscotti).
export interface Summary {
  kind: string;
  status: "queued" | "running" | "moving" | "kept" | "done" | "failed";
  slot?: number;
  where?: string;
  repo?: string;
  ssh?: { host: string; port: number; user: string };
  hostKey?: string;
  preview?: string;
  report?: string;
}
interface Row extends Summary {
  id: number;
  goal: string;
  // What it did and said, and (`owner`) what the owner told it.
  steps: { at: number; text?: string; tool?: string; owner?: true }[];
  started: number;
  updated: number;
}

const STEPS = 200;
const ROWS = 100;
const STATUS: Partial<Record<TaskEvent["type"], Row["status"]>> = { queued: "queued", started: "running", resumed: "running", moved: "running", moving: "moving", kept: "kept", done: "done" };

// Methods other plugins add (_biscotti/…), each answered with the params it was sent.
// `signal` aborts when the client goes away first.
type Extension = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const extensions = new Map<string, Extension>();
export const extension = (method: `_biscotti/${string}`, handler: Extension) => void extensions.set(method, handler);

// The board: every task's and VM's row, kept in the database across restarts.
function board(ctx: Context) {
  ctx.db.run(sql`CREATE TABLE IF NOT EXISTS tasks (id integer PRIMARY KEY, kind text NOT NULL DEFAULT 'task', goal text NOT NULL, status text NOT NULL, slot integer, "where" text, repo text, ssh text, preview text, report text, steps text NOT NULL, started integer NOT NULL, updated integer NOT NULL)`);
  const rows = new Map<number, Row>();
  for (const r of ctx.db.all<Record<string, unknown>>(sql`SELECT * FROM tasks ORDER BY updated DESC LIMIT ${ROWS}`).reverse()) {
    const row = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as Row;
    rows.set(row.id, { ...row, ssh: r.ssh ? JSON.parse(String(r.ssh)) : undefined, steps: JSON.parse(String(r.steps)) });
  }
  const screenshots = new Map<number, string>();
  const save = (t: Row) =>
    ctx.db.run(sql`INSERT OR REPLACE INTO tasks VALUES (${t.id}, ${t.kind}, ${t.goal}, ${t.status}, ${t.slot ?? null}, ${t.where ?? null}, ${t.repo ?? null}, ${t.ssh ? JSON.stringify(t.ssh) : null}, ${t.preview ?? null}, ${t.report ?? null}, ${JSON.stringify(t.steps)}, ${t.started}, ${t.updated})`);
  return {
    rows,
    screenshots,
    take(e: TaskEvent) {
      let t = rows.get(e.id);
      if (!t) rows.set(e.id, (t = { id: e.id, kind: "task", goal: "", status: "queued", started: e.at, updated: e.at, steps: [] }));
      t.updated = e.at;
      for (const field of ["goal", "kind", "repo", "ssh", "hostKey", "preview", "slot", "where"] as const) if (e[field] !== undefined) (t as unknown as Record<string, unknown>)[field] = e[field];
      t.status = STATUS[e.type] ?? (e.type === "failed" && t.status !== "moving" ? "failed" : t.status);
      if (e.type === "report") t.report = e.text;
      if (e.type === "report" && e.screenshot) screenshots.set(e.id, e.screenshot.toString("base64"));
      if (e.text && ["step", "moving", "failed"].includes(e.type)) t.steps.push({ at: e.at, text: e.text, tool: e.tool });
      if (e.text && (e.type === "told" || e.type === "resumed")) t.steps.push({ at: e.at, text: e.text, owner: true });
      t.steps.splice(0, Math.max(0, t.steps.length - STEPS));
      for (const old of [...rows.keys()].slice(0, Math.max(0, rows.size - ROWS))) (rows.delete(old), screenshots.delete(old));
      try {
        save(t);
      } catch (err) {
        console.error(`saving task #${t.id}: ${(err as Error).message}`);
      }
      return t;
    },
    forget(id: number) {
      rows.delete(id);
      ctx.db.run(sql`DELETE FROM tasks WHERE id = ${id}`);
    },
  };
}

const info = (t: Row, vms: Vms): acp.SessionInfo => {
  // Listed as kept only while its VM still is (one deleted over the limit is done).
  if (t.status === "kept" && !vms.kept().some((k) => k.id === t.id)) t.status = "done";
  const { id, goal, steps, started, updated, ...summary } = t;
  return { sessionId: String(id), cwd: t.repo ? "/home/cua/repo" : "/home/cua", title: goal.split("\n")[0].slice(0, 200), updatedAt: new Date(updated).toISOString(), _meta: { biscotti: summary } };
};
const say = (text: string): acp.ContentBlock => ({ type: "text", text });

// What an event (or a stored step) shows a session's follower.
function updates(e: Pick<TaskEvent, "id" | "type" | "text" | "tool" | "goal">, n: number, screenshot?: string): acp.SessionUpdate[] {
  if (e.type === "queued" && e.goal) return [{ sessionUpdate: "user_message_chunk", content: say(e.goal) }];
  if ((e.type === "resumed" || e.type === "told") && e.text) return [{ sessionUpdate: "user_message_chunk", content: say(e.text) }];
  if (e.type === "step" && e.tool) return [{ sessionUpdate: "tool_call", toolCallId: `${e.id}-${n}`, title: `${e.tool} ${e.text ?? ""}`.trim(), kind: "other", status: "completed", rawInput: e.text }];
  if (e.type === "step" && e.text) return [{ sessionUpdate: "agent_message_chunk", content: say(e.text) }];
  if (e.type === "report") return [{ sessionUpdate: "agent_message_chunk", content: say(e.text ?? "") }, ...(screenshot ? [{ sessionUpdate: "agent_message_chunk" as const, content: { type: "image" as const, data: screenshot, mimeType: "image/png" } }] : [])];
  if (e.type === "failed" || e.type === "moving") return [{ sessionUpdate: "agent_message_chunk", content: say(e.text ?? e.type) }];
  return [];
}

export default {
  async start(ctx) {
    if (!ctx.vms) return;
    const vms = ctx.vms;
    const tasks = board(ctx);
    const connections = new Set<acp.AgentContext>();
    // Prompts waiting on a task's next report (or its failing or stopping).
    const waiting = new Map<number, ((stop: acp.StopReason) => void)[]>();
    let seq = 0;
    // The desktop shape asked for at session/new, until the first prompt starts the task.
    const displays = new Map<number, "mobile" | "desktop">();

    taskEvents.on("event", (e) => {
      const t = tasks.take(e);
      const sessionId = String(e.id);
      const content = updates(e, ++seq, tasks.screenshots.get(e.id));
      const status: acp.SessionUpdate = { sessionUpdate: "session_info_update", title: t.goal.split("\n")[0].slice(0, 200), updatedAt: new Date(t.updated).toISOString(), _meta: { biscotti: info(t, vms)._meta!.biscotti } };
      for (const client of connections) {
        for (const update of [...content, status]) void client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => {});
        // Also on the connection's own stream (a session's updates go only to that session's stream, over HTTP), so a
        // board learns of every session as it starts and changes without following each one.
        void client.notify("_biscotti/session", { session: info(t, vms) }).catch(() => {});
      }
      const stop: acp.StopReason | undefined = e.type === "report" ? "end_turn" : e.type === "failed" ? (/stopped/.test(e.text ?? "") ? "cancelled" : "end_turn") : undefined;
      if (stop) for (const resolve of waiting.get(e.id)?.splice(0) ?? []) resolve(stop);
    });

    const known = (sessionId: string) => {
      const t = tasks.rows.get(Number(sessionId));
      if (!t) throw acp.RequestError.resourceNotFound(sessionId);
      return t;
    };
    const reported = (id: number) => new Promise<acp.StopReason>((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));

    const agent = acp
      .agent({ name: "biscotti" })
      .onConnect((connection) => {
        connections.add(connection.client);
        void connection.closed.finally(() => connections.delete(connection.client));
      })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "biscotti", version: "1" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }, promptCapabilities: {} },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.list, () => ({ sessions: [...tasks.rows.values()].sort((a, b) => b.updated - a.updated).map((t) => info(t, vms)) }))
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        const id = vms.reserve();
        const display = (params._meta?.biscotti as { display?: string } | undefined)?.display;
        if (display === "mobile" || display === "desktop") displays.set(id, display);
        return { sessionId: String(id) };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        const t = known(params.sessionId);
        const history = [
          ...updates({ id: t.id, type: "queued", goal: t.goal }, 0),
          ...t.steps.flatMap((s, i) => updates({ id: t.id, type: s.owner ? "told" : "step", text: s.text, tool: s.tool }, i)),
          ...(t.report ? updates({ id: t.id, type: "report", text: t.report }, t.steps.length, tasks.screenshots.get(t.id)) : []),
        ];
        for (const update of history) await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
        return {};
      })
      .onRequest(acp.methods.agent.session.resume, ({ params }) => (known(params.sessionId), {}))
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
        await vms.forget(Number(params.sessionId));
        tasks.forget(Number(params.sessionId));
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
        const id = Number(params.sessionId);
        const message = params.prompt.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
        if (!message) throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
        const t = tasks.rows.get(id);
        if (t && t.kind !== "task") throw acp.RequestError.invalidParams(undefined, "this is a VM to ssh into; it takes no prompts");
        const done = reported(id);
        if (!t) vms.start(message, { id, display: displays.get(id) }), displays.delete(id);
        else if (vms.tell(id, message) === "none") throw acp.RequestError.invalidParams(undefined, `task #${id} isn't running or kept`);
        return { stopReason: await done };
      })
      .onNotification(acp.methods.agent.session.cancel, ({ params }) => void vms.stop(Number(params.sessionId)))
      .onRequest("_biscotti/watch", (p) => p as { sessionId: string }, async ({ params }) => ({ url: (await vms.watch(Number(params.sessionId))) ?? null }))
      .onRequest("*", async ({ method, params, signal }) => {
        const handler = extensions.get(method);
        if (!handler) throw acp.RequestError.methodNotFound(method);
        return handler((params ?? {}) as Record<string, unknown>, signal);
      });

    const handle = createNodeHttpHandler(new AcpServer({ agent }));
    ctx.route("/acp", (req, res) => handle(req, res));
  },
} satisfies Plugin;
