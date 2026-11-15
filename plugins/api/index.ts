import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { emit, taskEvents, type Context, type Plugin, type TaskEvent, type Vms } from "@biscotti/core";
import { sql } from "drizzle-orm";

// The owner's apps (Concourse, in the dotfiles: its iPhone/Mac app and its Zellij plugin) reach biscotti as an ACP agent
// (agentclientprotocol.com), over its Streamable HTTP transport at /acp on the owner's API. Everything is a pi session,
// numbered as biscotti numbers them; _meta.biscotti.kind says which kind:
//   "main"     a conversation of the main agent, on this machine; all of them share its memory. "main" is the owner's
//              texts; what's said in another one is answered only there.
//   "sandbox"  pi in a VM, a subagent with its own computer: a task, started by a main session (_meta.biscotti.parent)
//   "vm"       a VM the owner works in over ssh (ssh-vms)
// and _meta.biscotti.source where it was started: "imessage", or what session/new said (e.g. {app, device}).
//
//   session/list     the board, newest first; each session's _meta.biscotti says what it is (Summary)
//   session/new      a new main session (_meta.biscotti.kind "sandbox": a task to come, whose first prompt is the goal,
//                    its report going to the main agent; _meta.biscotti.display "mobile" or "desktop" for its desktop)
//   session/prompt   the owner's message: to a main session (answered when the agent's turn is done), or a task's goal,
//                    or a message for a running or kept one (answered when it reports)
//   session/cancel   stop it (its VM is kept)
//   session/load     its history replayed, and followed; session/resume follows it, session/close stops
//   session/delete   its kept VM deleted, and its row
//
// What a task does comes as session/update: the goal and the owner's messages (user_message_chunk), each tool call
// (tool_call), what it says and its report, with its screenshot (agent_message_chunk), and session_info_update as its
// status changes, to each connection that opened the session (session/new, prompt, load or resume). Every
// connection also gets each change of every session as _biscotti/session {session: SessionInfo} on its own stream,
// for a board without following each session. Plugins add methods of
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
  parent?: string;
  source?: unknown;
  // A main session's model, thinking level and context use (tokens), as of its last turn.
  model?: string;
  thinking?: string;
  used?: number;
  size?: number;
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
const STATUS: Partial<Record<TaskEvent["type"], Row["status"]>> = { queued: "queued", started: "running", resumed: "running", moved: "running", moving: "moving", kept: "kept", done: "done", replied: "done" };
// Sessions by number, the owner's texts being "main" (0).
const sid = (id: number) => (id === 0 ? "main" : String(id));
const idOf = (sessionId: string) => (sessionId === "main" ? 0 : Number(sessionId));
// Kinds from before sessions had these names.
const KINDS: Record<string, string> = { task: "sandbox", box: "vm" };

// Methods other plugins add (_biscotti/…), each answered with the params it was sent.
// `signal` aborts when the client goes away first.
type Extension = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const extensions = new Map<string, Extension>();
export const extension = (method: `_biscotti/${string}`, handler: Extension) => void extensions.set(method, handler);

// The board: every task's and VM's row, kept in the database across restarts.
function board(ctx: Context) {
  ctx.db.run(sql`CREATE TABLE IF NOT EXISTS tasks (id integer PRIMARY KEY, kind text NOT NULL DEFAULT 'task', goal text NOT NULL, status text NOT NULL, slot integer, "where" text, repo text, ssh text, preview text, report text, steps text NOT NULL, started integer NOT NULL, updated integer NOT NULL)`);
  for (const column of ["parent", "source"]) {
    try {
      ctx.db.run(sql.raw(`ALTER TABLE tasks ADD COLUMN ${column} text`));
    } catch {}
  }
  const rows = new Map<number, Row>();
  for (const r of ctx.db.all<Record<string, unknown>>(sql`SELECT * FROM tasks ORDER BY updated DESC LIMIT ${ROWS}`).reverse()) {
    const row = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as Row;
    rows.set(row.id, { ...row, kind: KINDS[row.kind] ?? row.kind, ssh: r.ssh ? JSON.parse(String(r.ssh)) : undefined, source: r.source ? JSON.parse(String(r.source)) : undefined, steps: JSON.parse(String(r.steps)) });
  }
  // The owner's texts are main session 0, whatever was saved for it before.
  const texts = rows.get(0);
  rows.set(0, { id: 0, status: "done", steps: [], started: Date.now(), updated: Date.now(), ...texts, goal: texts?.goal || "Texts", kind: "main", source: "imessage" });
  const screenshots = new Map<number, string>();
  const save = (t: Row) =>
    ctx.db.run(sql`INSERT OR REPLACE INTO tasks VALUES (${t.id}, ${t.kind}, ${t.goal}, ${t.status}, ${t.slot ?? null}, ${t.where ?? null}, ${t.repo ?? null}, ${t.ssh ? JSON.stringify(t.ssh) : null}, ${t.preview ?? null}, ${t.report ?? null}, ${JSON.stringify(t.steps)}, ${t.started}, ${t.updated}, ${t.parent ?? null}, ${t.source === undefined ? null : JSON.stringify(t.source)})`);
  return {
    rows,
    screenshots,
    take(e: TaskEvent) {
      let t = rows.get(e.id);
      if (!t) rows.set(e.id, (t = { id: e.id, kind: "sandbox", goal: "", status: "queued", started: e.at, updated: e.at, steps: [] }));
      t.updated = e.at;
      for (const field of ["goal", "kind", "repo", "ssh", "hostKey", "preview", "slot", "where", "parent", "source", "model", "thinking", "used", "size"] as const) if (e[field] !== undefined) (t as unknown as Record<string, unknown>)[field] = e[field];
      // A main session is titled by what the owner first said in it.
      if (e.type === "told" && t.kind === "main" && t.goal === "New session" && e.text) t.goal = e.text;
      if (e.type === "told") t.status = "running";
      t.status = STATUS[e.type] ?? (e.type === "failed" && t.status !== "moving" ? "failed" : t.status);
      if (e.type === "report") t.report = e.text;
      if ((e.type === "report" || e.type === "replied") && e.screenshot) screenshots.set(e.id, e.screenshot.toString("base64"));
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
  return { sessionId: sid(id), cwd: t.repo ? "/home/cua/repo" : "/home/cua", title: goal.split("\n")[0].slice(0, 200), updatedAt: new Date(updated).toISOString(), _meta: { biscotti: summary } };
};
const say = (text: string): acp.ContentBlock => ({ type: "text", text });

// What an event (or a stored step) shows a session's follower.
function updates(e: Pick<TaskEvent, "id" | "type" | "text" | "tool" | "goal">, n: number, screenshot?: string): acp.SessionUpdate[] {
  if (e.type === "queued" && e.goal) return [{ sessionUpdate: "user_message_chunk", content: say(e.goal) }];
  if ((e.type === "resumed" || e.type === "told") && e.text) return [{ sessionUpdate: "user_message_chunk", content: say(e.text), messageId: `${e.id}-${n}-owner` }];
  if (e.type === "step" && e.tool) return [{ sessionUpdate: "tool_call", toolCallId: `${e.id}-${n}`, title: `${e.tool} ${e.text ?? ""}`.trim(), kind: "other", status: "completed", rawInput: e.text }];
  // Each is a whole message, with its own id, so a client doesn't join two in a row.
  const messageId = `${e.id}-${n}`;
  if (e.type === "step" && e.text) return [{ sessionUpdate: "agent_message_chunk", content: say(e.text), messageId }];
  if (e.type === "report") return [{ sessionUpdate: "agent_message_chunk", content: say(e.text ?? ""), messageId }, ...(screenshot ? [{ sessionUpdate: "agent_message_chunk" as const, content: { type: "image" as const, data: screenshot, mimeType: "image/png" }, messageId }] : [])];
  if (e.type === "failed" || e.type === "moving") return [{ sessionUpdate: "agent_message_chunk", content: say(e.text ?? e.type), messageId }];
  if (e.type === "status") return status(e as Record<string, unknown>);
  return [];
}
// A main session's model and thinking level (config options, for display) and its context use.
function status(e: { model?: unknown; thinking?: unknown; used?: unknown; size?: unknown }): acp.SessionUpdate[] {
  const select = (id: string, name: string, category: "model" | "thought_level", value: string) => ({ id, name, category, type: "select" as const, currentValue: value, options: [{ value, name: value }] });
  return [
    ...(typeof e.used === "number" && typeof e.size === "number" ? [{ sessionUpdate: "usage_update" as const, used: e.used, size: e.size }] : []),
    { sessionUpdate: "config_option_update", configOptions: [...(typeof e.model === "string" ? [select("model", "Model", "model", e.model)] : []), ...(typeof e.thinking === "string" ? [select("thinking", "Thinking", "thought_level", e.thinking)] : [])] },
  ];
}
// What a main session takes besides messages.
const COMMANDS: acp.SessionUpdate = { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Summarize the conversation so far, to free its context" }] };

export default {
  async start(ctx) {
    if (!ctx.vms) return;
    const vms = ctx.vms;
    const tasks = board(ctx);
    // Each open connection (keyed by the SDK's connection object, which every request's context shares) and the
    // sessions it opened.
    const connections = new Map<object, { client: acp.AgentContext; follows: Set<string> }>();
    const of = (client: acp.AgentContext) => (client as unknown as { cx: object }).cx;
    const follow = (client: acp.AgentContext, sessionId: string) => connections.get(of(client))?.follows.add(sessionId);
    // Prompts waiting on a task's next report (or its failing or stopping).
    const waiting = new Map<number, ((stop: acp.StopReason) => void)[]>();
    let seq = 0;
    // The desktop shape asked for at session/new, until the first prompt starts the task.
    const displays = new Map<number, "mobile" | "desktop">();
    const sources = new Map<number, unknown>();

    taskEvents.on("event", (e) => {
      const t = tasks.take(e);
      const sessionId = sid(e.id);
      const content = updates(e, ++seq, tasks.screenshots.get(e.id));
      const status: acp.SessionUpdate = { sessionUpdate: "session_info_update", title: t.goal.split("\n")[0].slice(0, 200), updatedAt: new Date(t.updated).toISOString(), _meta: { biscotti: info(t, vms)._meta!.biscotti } };
      for (const { client, follows } of connections.values()) {
        if (follows.has(sessionId)) for (const update of [...content, status]) void client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => {});
        // Also on the connection's own stream (a session's updates go only to that session's stream, over HTTP), so a
        // board learns of every session as it starts and changes without following each one.
        void client.notify("_biscotti/session", { session: info(t, vms) }).catch(() => {});
      }
      const stop: acp.StopReason | undefined = e.type === "report" || e.type === "replied" ? "end_turn" : e.type === "failed" ? (/stopped/.test(e.text ?? "") ? "cancelled" : "end_turn") : undefined;
      if (stop) for (const resolve of waiting.get(e.id)?.splice(0) ?? []) resolve(stop);
    });

    const known = (sessionId: string) => {
      const t = tasks.rows.get(idOf(sessionId));
      if (!t) throw acp.RequestError.resourceNotFound(sessionId);
      return t;
    };
    const reported = (id: number) => new Promise<acp.StopReason>((resolve) => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));

    const agent = acp
      .agent({ name: "biscotti" })
      .onConnect((connection) => {
        connections.set(of(connection.client), { client: connection.client, follows: new Set() });
        void connection.closed.finally(() => connections.delete(of(connection.client)));
      })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "biscotti", version: "1" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }, promptCapabilities: {} },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.list, () => ({ sessions: [...tasks.rows.values()].sort((a, b) => b.updated - a.updated).map((t) => info(t, vms)) }))
      .onRequest(acp.methods.agent.session.new, ({ params, client }) => {
        const asked = (params._meta?.biscotti ?? {}) as { kind?: string; display?: string; source?: unknown };
        const id = vms.reserve();
        follow(client, String(id));
        if (asked.kind === "sandbox") {
          if (asked.display === "mobile" || asked.display === "desktop") displays.set(id, asked.display);
          if (asked.source !== undefined) sources.set(id, asked.source);
        } else {
          emit({ id, type: "done", kind: "main", goal: "New session", ...(asked.source !== undefined && { source: asked.source }) });
          void client.notify(acp.methods.client.session.update, { sessionId: String(id), update: COMMANDS }).catch(() => {});
        }
        return { sessionId: String(id) };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        const t = known(params.sessionId);
        follow(client, params.sessionId);
        const history = [
          ...(t.kind === "main" ? [] : updates({ id: t.id, type: "queued", goal: t.goal }, 0)),
          ...t.steps.flatMap((s, i) => updates({ id: t.id, type: s.owner ? "told" : "step", text: s.text, tool: s.tool }, i)),
          ...(t.report ? updates({ id: t.id, type: "report", text: t.report }, t.steps.length, tasks.screenshots.get(t.id)) : []),
        ];
        if (t.kind === "main") history.push(COMMANDS, ...status(t));
        for (const update of history) await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
        return {};
      })
      .onRequest(acp.methods.agent.session.resume, ({ params, client }) => (known(params.sessionId), follow(client, params.sessionId), {}))
      .onRequest(acp.methods.agent.session.close, ({ params, client }) => (connections.get(of(client))?.follows.delete(params.sessionId), {}))
      .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
        await vms.forget(idOf(params.sessionId));
        tasks.forget(idOf(params.sessionId));
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        follow(client, params.sessionId);
        const id = idOf(params.sessionId);
        const message = params.prompt.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
        if (!message) throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
        const t = tasks.rows.get(id);
        if (t?.kind === "vm") throw acp.RequestError.invalidParams(undefined, "this is a VM to ssh into; it takes no prompts");
        if (t?.kind === "main") {
          if (!ctx.converse) throw acp.RequestError.internalError(undefined, "no main agent here");
          const done = reported(id);
          void ctx.converse(sid(id), message);
          return { stopReason: await done };
        }
        const done = reported(id);
        if (!t) {
          emit({ id, type: "queued", goal: message, kind: "sandbox", ...(sources.has(id) && { source: sources.get(id) }) });
          vms.start(message, { id, display: displays.get(id) }), displays.delete(id), sources.delete(id);
        }
        else if (vms.tell(id, message) === "none") throw acp.RequestError.invalidParams(undefined, `task #${id} isn't running or kept`);
        return { stopReason: await done };
      })
      .onNotification(acp.methods.agent.session.cancel, ({ params }) => void vms.stop(idOf(params.sessionId)))
      .onRequest("_biscotti/watch", (p) => p as { sessionId: string }, async ({ params }) => ({ url: (await vms.watch(idOf(params.sessionId))) ?? null }))
      .onRequest("*", async ({ method, params, signal }) => {
        const handler = extensions.get(method);
        if (!handler) throw acp.RequestError.methodNotFound(method);
        return handler((params ?? {}) as Record<string, unknown>, signal);
      });

    const handle = createNodeHttpHandler(new AcpServer({ agent }));
    ctx.route("/acp", (req, res) => handle(req, res));
  },
} satisfies Plugin;
