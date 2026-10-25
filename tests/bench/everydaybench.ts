// The bench's tasks are EverydayBench's (github.com/lucasgelfond/EverydayBench): made-up sites with everyday errands,
// each graded from the sites' databases. EverydayBench serves the sites to the VMs' browsers and keeps the tasks;
// biscotti only names them. Its control port (EVERYDAYBENCH_CONTROL) hands out a run (the prompt, the start page,
// logins for the vault) and grades it.
import type { Db } from "../../core/src/memory.ts";
import { saveSecret } from "../../core/src/plugin.ts";
import { open } from "./browser.ts";

export const CONTROL = process.env.EVERYDAYBENCH_CONTROL ?? "http://127.0.0.1:8701";
// How the sites behave in every run, as JSON, e.g. {"hideAria": true} or {"latencyMs": 2000}.
const CONDITIONS = process.env.EVERYDAYBENCH_CONDITIONS ? JSON.parse(process.env.EVERYDAYBENCH_CONDITIONS) : undefined;

export type Task = {
  goal: string;
  // Before the agent starts, on the VM's browser: the run's start page open, its logins in the vault.
  setup?: (browser: string) => Promise<void>;
  pass: (report: string) => Promise<boolean>;
  // The owner's texts now due mid-run (EverydayBench decides when, from what the browser did), each returned once.
  followups?: () => Promise<{ id: string; text: string }[]>;
  // What the grade said, for the results.
  graded?: Grade & { run: string };
};

async function control<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`EverydayBench ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type Grade = { pass: boolean; progress: number; parts: Record<string, boolean>; diff: unknown; assertions: unknown; answer: unknown };
export const grade = (run: string, report: string) => control<Grade>(`/runs/${run}/grade`, { report });

// A run's follow-ups now due; none from an EverydayBench without them (a 404) or when it can't be reached.
export async function followups(run: string): Promise<{ id: string; text: string }[]> {
  const res = await fetch(`${CONTROL}/runs/${run}/followups`).catch(() => undefined);
  if (!res?.ok) return [];
  const due = await res.json().catch(() => []);
  return Array.isArray(due) ? due : [];
}

// Logins by site ("lumiscope_email", "lumiscope_password" -> a Lumiscope entry with email and password).
function saveKnown(db: Db, known: Record<string, string>) {
  const bySite: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(known)) {
    const [site, ...field] = key.split("_");
    (bySite[site!] ??= {})[field.join("_") || key] = value;
  }
  for (const [site, fields] of Object.entries(bySite)) saveSecret(db, site[0]!.toUpperCase() + site.slice(1), fields);
}

// The vault entries a task's logins go in ("lumiscope_email" -> Lumiscope), by task id. The bench's tasks share one
// vault, so two tasks with the same entry can't run at once: one's setup (or password reset) would overwrite the other's.
export async function everydayBenchLogins(): Promise<Record<string, string[]>> {
  const list = await control<{ id: string }[]>("/tasks");
  const known = await Promise.all(list.map(({ id }) => control<{ known: Record<string, string> }>(`/tasks/${id}`)));
  return Object.fromEntries(list.map(({ id }, i) => [id, [...new Set(Object.keys(known[i]!.known).map((k) => k.split("_")[0]!))]]));
}

// Every EverydayBench task, by id; a run of one starts a fresh world for it.
export async function everydayBenchTasks(db: Db): Promise<Record<string, () => Promise<Task>>> {
  const list = await control<{ id: string }[]>("/tasks");
  return Object.fromEntries(
    list.map(({ id }) => [
      id,
      async () => {
        const run = await control<{ run: string; start: string; prompt: string; known: Record<string, string> }>("/runs", { task: id, conditions: CONDITIONS });
        const task: Task = {
          goal: run.prompt,
          setup: async (browser) => {
            saveKnown(db, run.known);
            await open(browser, run.start);
          },
          followups: () => followups(run.run),
          async pass(report) {
            const g = await grade(run.run, report);
            task.graded = { run: run.run, ...g };
            return g.pass;
          },
        };
        return task;
      },
    ]),
  );
}
