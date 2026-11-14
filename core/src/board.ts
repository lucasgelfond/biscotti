import { desc, sql } from "drizzle-orm";
import type { openDb } from "./memory.ts";
import { tasks as table } from "./schema.ts";
import { taskEvents, type TaskEvent } from "./tasks.ts";

// Tasks and boxes for the task API (api.ts), from taskEvents, kept in the gate's database (`store`) across restarts.
export interface BoardTask {
  id: number;
  kind: "task" | "box";
  goal: string;
  status: "queued" | "running" | "moving" | "kept" | "done" | "failed";
  slot?: number;
  where?: "local" | "cloud";
  repo?: string;
  ssh?: { host: string; port: number; user: string };
  preview?: string;
  started: number;
  updated: number;
  steps: { at: number; text?: string; tool?: string }[];
  report?: string;
  screenshot: boolean;
}

export interface BoardStore {
  load(limit: number): BoardTask[];
  save(task: BoardTask): void;
}

const STEPS = 200;
const TASKS = 100;

export function taskBoard(kept: () => { id: number; goal: string; slot: number; at: number }[] = () => [], store?: BoardStore) {
  const tasks = new Map<number, BoardTask>();
  for (const t of store?.load(TASKS).reverse() ?? []) tasks.set(t.id, { ...t, screenshot: false });
  const screenshots = new Map<number, Buffer>();
  const of = (e: TaskEvent) => {
    let t = tasks.get(e.id);
    if (!t) tasks.set(e.id, (t = { id: e.id, kind: e.kind ?? "task", goal: e.goal ?? "", status: "queued", started: e.at, updated: e.at, steps: [], screenshot: false }));
    return t;
  };
  taskEvents.on("event", (e: TaskEvent) => {
    const t = of(e);
    t.updated = e.at;
    if (e.goal) t.goal = e.goal;
    if (e.kind) t.kind = e.kind;
    if (e.repo) t.repo = e.repo;
    if (e.ssh) t.ssh = e.ssh;
    if (e.preview) t.preview = e.preview;
    if (e.slot !== undefined) Object.assign(t, { slot: e.slot, where: e.where });
    if (e.type === "queued") t.status = "queued";
    if (e.type === "started" || e.type === "resumed" || e.type === "moved") t.status = "running";
    if (e.type === "moving") t.status = "moving";
    if (e.type === "kept") t.status = "kept";
    if (e.type === "done") t.status = "done";
    if (e.type === "failed") t.status = t.status === "moving" ? "moving" : "failed";
    if (e.type === "report") {
      t.report = e.text;
      if (e.screenshot) (screenshots.set(e.id, e.screenshot), (t.screenshot = true));
    }
    if (e.type === "step" || e.type === "resumed" || e.type === "moving" || e.type === "failed") t.steps.push({ at: e.at, text: e.text, tool: e.tool });
    if (t.steps.length > STEPS) t.steps.splice(0, t.steps.length - STEPS);
    for (const old of [...tasks.keys()].slice(0, Math.max(0, tasks.size - TASKS))) (tasks.delete(old), screenshots.delete(old));
    try {
      store?.save(t);
    } catch (err) {
      console.error(`saving task #${t.id}: ${(err as Error).message}`);
    }
  });
  return {
    // Newest first.
    list(): BoardTask[] {
      for (const k of kept()) {
        if (!tasks.has(k.id)) tasks.set(k.id, { id: k.id, kind: "task", goal: k.goal, status: "kept", slot: k.slot, where: k.slot > 100 ? "cloud" : "local", started: k.at, updated: k.at, steps: [], screenshot: false });
      }
      return [...tasks.values()].sort((a, b) => b.updated - a.updated);
    },
    get: (id: number) => tasks.get(id),
    screenshot: (id: number) => screenshots.get(id),
    // The highest number used, so numbering carries on after a restart.
    lastId: () => Math.max(0, ...tasks.keys()),
  };
}

// The board's rows in the gate's database.
export function boardStore(db: ReturnType<typeof openDb>) {
  return {
    load: (limit: number): BoardTask[] =>
      db.select().from(table).orderBy(desc(table.updated)).limit(limit).all().map((r) => ({
        id: r.id,
        kind: r.kind === "box" ? "box" : "task",
        goal: r.goal,
        status: r.status as BoardTask["status"],
        slot: r.slot ?? undefined,
        where: (r.where ?? undefined) as BoardTask["where"],
        repo: r.repo ?? undefined,
        ssh: r.ssh ?? undefined,
        preview: r.preview ?? undefined,
        report: r.report ?? undefined,
        steps: r.steps,
        started: r.started,
        updated: r.updated,
        screenshot: false,
      })),
    save(t: BoardTask) {
      const { screenshot, ...row } = t;
      db.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row }).run();
    },
    lastId: () => db.select({ id: sql<number>`coalesce(max(${table.id}), 0)` }).from(table).get()?.id ?? 0,
  } satisfies BoardStore & { lastId(): number };
}
