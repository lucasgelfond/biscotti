import { taskEvents, type TaskEvent } from "./tasks.ts";

// Every task the gate has seen since it started, from taskEvents: what it is, where it runs, what it's done. For the
// app's API (api.ts); tasks before a restart show only if they're still kept (suspended).
export interface BoardTask {
  id: number;
  goal: string;
  status: "queued" | "running" | "moving" | "kept" | "done" | "failed";
  slot?: number;
  where?: "local" | "cloud";
  started: number;
  updated: number;
  steps: { at: number; text?: string; tool?: string }[];
  report?: string;
  screenshot: boolean;
}

const STEPS = 200;
const TASKS = 100;

export function taskBoard(kept: () => { id: number; goal: string; slot: number; at: number }[] = () => []) {
  const tasks = new Map<number, BoardTask>();
  const screenshots = new Map<number, Buffer>();
  const of = (e: TaskEvent) => {
    let t = tasks.get(e.id);
    if (!t) tasks.set(e.id, (t = { id: e.id, goal: e.goal ?? "", status: "queued", started: e.at, updated: e.at, steps: [], screenshot: false }));
    return t;
  };
  taskEvents.on("event", (e: TaskEvent) => {
    const t = of(e);
    t.updated = e.at;
    if (e.goal) t.goal = e.goal;
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
  });
  return {
    // Newest first; kept tasks from before a restart included.
    list(): BoardTask[] {
      for (const k of kept()) {
        if (!tasks.has(k.id)) tasks.set(k.id, { id: k.id, goal: k.goal, status: "kept", slot: k.slot, where: k.slot > 100 ? "cloud" : "local", started: k.at, updated: k.at, steps: [], screenshot: false });
      }
      return [...tasks.values()].sort((a, b) => b.updated - a.updated);
    },
    get: (id: number) => tasks.get(id),
    screenshot: (id: number) => screenshots.get(id),
  };
}
