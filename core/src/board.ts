import { sql } from "drizzle-orm";
import type { Db } from "./memory.ts";
import { taskEvents, type TaskEvent, type Vms } from "./plugin.ts";

// The board: every task's (a sandbox's) and VM's row, from what happens to them (taskEvents), kept in the database
// across restarts, for the owner's apps (AHP chats beside the session that started each, sandboxes.ts).

export interface Row {
  id: number;
  // "sandbox": a task, started by a main session (`parent`); "vm": one the owner works in over ssh (ssh-vms).
  kind: string;
  goal: string;
  status: "queued" | "running" | "kept" | "done" | "failed";
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
  started: number;
  updated: number;
}

const ROWS = 100;
const STATUS: Partial<Record<TaskEvent["type"], Row["status"]>> = { queued: "queued", started: "running", resumed: "running", kept: "kept", done: "done" };
const FIELDS = ["goal", "kind", "repo", "ssh", "hostKey", "preview", "site", "slot", "where", "parent"] as const;

export type Board = ReturnType<typeof board>;
export function board(db: Db, vms: Vms) {
  db.run(sql`CREATE TABLE IF NOT EXISTS tasks (id integer PRIMARY KEY, kind text NOT NULL DEFAULT 'sandbox', goal text NOT NULL, status text NOT NULL, slot integer, "where" text, repo text, ssh text, preview text, site text, report text, parent text, started integer NOT NULL, updated integer NOT NULL)`);
  // TODO: remove once every install has started since (the kinds' old names, on the Pi's).
  db.run(sql`UPDATE tasks SET kind = CASE kind WHEN 'task' THEN 'sandbox' ELSE 'vm' END WHERE kind IN ('task', 'box')`);
  const rows = new Map<number, Row>();
  for (const r of db.all<Record<string, unknown>>(sql`SELECT * FROM tasks WHERE kind IN ('sandbox', 'vm') ORDER BY updated DESC LIMIT ${ROWS}`).reverse()) {
    const row = Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== null && k !== "steps")) as unknown as Row;
    rows.set(row.id, { ...row, ssh: r.ssh ? JSON.parse(String(r.ssh)) : undefined });
  }
  const save = (t: Row) =>
    db.run(sql`INSERT OR REPLACE INTO tasks (id, kind, goal, status, slot, "where", repo, ssh, preview, site, report, started, updated, parent)
      VALUES (${t.id}, ${t.kind}, ${t.goal}, ${t.status}, ${t.slot ?? null}, ${t.where ?? null}, ${t.repo ?? null}, ${t.ssh ? JSON.stringify(t.ssh) : null}, ${t.preview ?? null}, ${t.site ?? null}, ${t.report ?? null}, ${t.started}, ${t.updated}, ${t.parent ?? null})`);
  const listeners = new Set<(row: Row) => void>();
  const tell = (row: Row) => {
    for (const listener of listeners) listener(row);
  };

  taskEvents.on("event", (e) => {
    if (!Number.isInteger(e.id)) return;
    let t = rows.get(e.id);
    if (!t) rows.set(e.id, (t = { id: e.id, kind: "sandbox", goal: "", status: "queued", started: e.at, updated: e.at }));
    t.updated = e.at;
    for (const field of FIELDS) if (e[field] !== undefined) (t as unknown as Record<string, unknown>)[field] = e[field];
    t.status = STATUS[e.type] ?? (e.type === "failed" ? "failed" : t.status);
    if (e.type === "report") t.report = e.text;
    for (const old of [...rows.keys()].slice(0, Math.max(0, rows.size - ROWS))) rows.delete(old);
    try {
      save(t);
    } catch (err) {
      console.error(`saving task #${t.id}: ${(err as Error).message}`);
    }
    tell(t);
  });

  return {
    rows,
    // A row as the apps see it: kept only while its VM still is (one deleted over the limit is done).
    summary(t: Row): Row {
      if (t.status === "kept" && !vms.kept().some((k) => k.id === t.id)) t.status = "done";
      return t;
    },
    // Each change of a row.
    on(listener: (row: Row) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    forget(id: number) {
      rows.delete(id);
      db.run(sql`DELETE FROM tasks WHERE id = ${id}`);
      tell({ id, kind: "gone", goal: "", status: "done", started: 0, updated: Date.now() });
    },
  };
}
