import { sql } from "drizzle-orm";
import type { Db } from "./memory.ts";
import { taskEvents, type TaskEvent, type Vms } from "./plugin.ts";

// The board: every task's, VM's and main session's row, from what happens to them (taskEvents), kept in the database
// across restarts, for the owner's apps (AHP sandbox and VM chats, agent.ts; the api plugin's ACP sessions). Numbered as
// biscotti numbers them, the owner's texts being 0. `kind` says which kind:
//   "main"     a conversation of the main agent
//   "sandbox"  a task: a subagent with its own computer, started by a main session (`parent`)
//   "vm"       a VM the owner works in over ssh (ssh-vms)

// What the board knows of one.
export interface Summary {
  kind: string;
  status: "queued" | "running" | "moving" | "kept" | "done" | "failed";
  slot?: number;
  where?: string;
  repo?: string;
  ssh?: { host: string; port: number; user: string };
  hostKey?: string;
  preview?: string;
  // A task's app, running in its VM (a coding task's preview).
  site?: string;
  report?: string;
  parent?: string;
  source?: unknown;
  // A main session's model, thinking level and context use (tokens), as of its last turn.
  model?: string;
  thinking?: string;
  used?: number;
  size?: number;
}
export interface Row extends Summary {
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
// Kinds from before sessions had these names.
const KINDS: Record<string, string> = { task: "sandbox", box: "vm" };

export type Board = ReturnType<typeof board>;
export function board(db: Db, vms: Vms) {
  db.run(sql`CREATE TABLE IF NOT EXISTS tasks (id integer PRIMARY KEY, kind text NOT NULL DEFAULT 'task', goal text NOT NULL, status text NOT NULL, slot integer, "where" text, repo text, ssh text, preview text, report text, steps text NOT NULL, started integer NOT NULL, updated integer NOT NULL)`);
  for (const column of ["parent text", "source text", "model text", "thinking text", "used integer", "size integer", "site text"]) {
    try {
      db.run(sql.raw(`ALTER TABLE tasks ADD COLUMN ${column}`));
    } catch {}
  }
  const rows = new Map<number, Row>();
  for (const r of db.all<Record<string, unknown>>(sql`SELECT * FROM tasks ORDER BY updated DESC LIMIT ${ROWS}`).reverse()) {
    const row = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as Row;
    rows.set(row.id, { ...row, kind: KINDS[row.kind] ?? row.kind, ssh: r.ssh ? JSON.parse(String(r.ssh)) : undefined, source: r.source ? JSON.parse(String(r.source)) : undefined, steps: JSON.parse(String(r.steps)) });
  }
  // The owner's texts are main session 0, whatever was saved for it before.
  const texts = rows.get(0);
  rows.set(0, { id: 0, status: "done", steps: [], started: Date.now(), updated: Date.now(), ...texts, goal: texts?.goal || "Texts", kind: "main", source: "imessage" });
  const screenshots = new Map<number, string>();
  const save = (t: Row) =>
    db.run(sql`INSERT OR REPLACE INTO tasks (id, kind, goal, status, slot, "where", repo, ssh, preview, site, report, steps, started, updated, parent, source, model, thinking, used, size)
      VALUES (${t.id}, ${t.kind}, ${t.goal}, ${t.status}, ${t.slot ?? null}, ${t.where ?? null}, ${t.repo ?? null}, ${t.ssh ? JSON.stringify(t.ssh) : null}, ${t.preview ?? null}, ${t.site ?? null}, ${t.report ?? null}, ${JSON.stringify(t.steps)}, ${t.started}, ${t.updated}, ${t.parent ?? null}, ${t.source === undefined ? null : JSON.stringify(t.source)}, ${t.model ?? null}, ${t.thinking ?? null}, ${t.used ?? null}, ${t.size ?? null})`);
  const listeners = new Set<(row: Row, e?: TaskEvent) => void>();

  function take(e: TaskEvent) {
    let t = rows.get(e.id);
    if (!t) rows.set(e.id, (t = { id: e.id, kind: "sandbox", goal: "", status: "queued", started: e.at, updated: e.at, steps: [] }));
    t.updated = e.at;
    for (const field of ["goal", "kind", "repo", "ssh", "hostKey", "preview", "site", "slot", "where", "parent", "source", "model", "thinking", "used", "size"] as const) if (e[field] !== undefined) (t as unknown as Record<string, unknown>)[field] = e[field];
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
  }
  taskEvents.on("event", (e) => {
    const t = take(e);
    for (const listener of listeners) listener(t, e);
  });

  return {
    rows,
    screenshots,
    // A row as the apps see it: kept only while its VM still is (one deleted over the limit is done).
    summary(t: Row): Row {
      if (t.status === "kept" && !vms.kept().some((k) => k.id === t.id)) t.status = "done";
      return t;
    },
    // Each change of a row, with the event that made it.
    on(listener: (row: Row, e?: TaskEvent) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    forget(id: number) {
      rows.delete(id);
      db.run(sql`DELETE FROM tasks WHERE id = ${id}`);
      for (const listener of listeners) listener({ id, kind: "gone", goal: "", status: "done", steps: [], started: 0, updated: Date.now() });
    },
  };
}
