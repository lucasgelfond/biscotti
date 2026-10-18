import { defineTool } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import { wakes, type Db } from "./db.ts";

// Wakes: the agent saves a prompt for itself with a schedule; when it comes due, the prompt returns to the conversation
// as a message, so the agent does it (reminding the owner, or starting a task and summarizing) like anything texted.

type Wake = typeof wakes.$inferSelect;

// The next time a wake is due after its last run (or its creation); null once a one-time wake has run.
function nextRun(wake: Wake, timezone: string) {
  return new Cron(wake.when, { timezone }).nextRun(wake.lastRun ?? wake.createdAt);
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function wakeTools(db: Db, timezone: string) {
  const schedule = defineTool({
    name: "schedule",
    label: "Schedule",
    description: `Wake yourself up later with a prompt, once or on a schedule (times are in ${timezone}). When it's due, the prompt comes back to you as a message starting "Wake"; do what it says then.`,
    parameters: Type.Object({
      label: Type.String({ description: "A short name the owner would recognize, e.g. 'Monday call-mom reminder'." }),
      when: Type.String({
        description: "A cron expression for repeating wakes (e.g. '0 20 * * 1' is Mondays at 8pm), or a local date and time for once (e.g. '2026-10-20T09:00:00').",
      }),
      prompt: Type.String({
        description: "An instruction to your future self, e.g. 'Remind the owner to call Mom' or 'Check SF flight prices with a task and summarize them for the owner'.",
      }),
    }),
    async execute(_id, { label, when, prompt }) {
      const next = new Cron(when, { timezone }).nextRun();
      if (!next) return text(`"${when}" never comes up again; give a future time or a cron expression.`);
      const [wake] = db.insert(wakes).values({ label, when, prompt }).returning().all();
      return text(`Scheduled wake ${wake.id} (${label}); next ${next.toLocaleString("en-US", { timeZone: timezone })}.`);
    },
  });

  const list = defineTool({
    name: "list_wakes",
    label: "Wakes",
    description: "List scheduled wakes with their next run.",
    parameters: Type.Object({}),
    async execute() {
      const lines = db
        .select()
        .from(wakes)
        .all()
        .map((w) => `[${w.id}] ${w.label} (${w.when}); next ${nextRun(w, timezone)?.toLocaleString("en-US", { timeZone: timezone })}: ${w.prompt}`);
      return text(lines.length ? lines.join("\n") : "No wakes scheduled.");
    },
  });

  const cancel = defineTool({
    name: "cancel_wake",
    label: "Cancel wake",
    description: "Cancel a scheduled wake by id (from list_wakes).",
    parameters: Type.Object({ id: Type.Integer() }),
    async execute(_id, { id }) {
      const deleted = db.delete(wakes).where(eq(wakes.id, id)).returning().all();
      return text(deleted.length ? `Cancelled wake ${id}.` : `No wake ${id}.`);
    },
  });

  return [schedule, list, cancel];
}

// Checks for due wakes every `intervalMs` and hands each to `fire`. One-time wakes are removed once they've run.
export function startWakes(db: Db, timezone: string, fire: (wake: Wake) => Promise<void>, intervalMs = 30_000) {
  return setInterval(async () => {
    const now = new Date();
    for (const wake of db.select().from(wakes).all()) {
      const due = nextRun(wake, timezone);
      if (!due || due > now) continue;
      db.update(wakes).set({ lastRun: now }).where(eq(wakes.id, wake.id)).run();
      if (!nextRun({ ...wake, lastRun: now }, timezone)) db.delete(wakes).where(eq(wakes.id, wake.id)).run();
      await fire(wake);
    }
  }, intervalMs);
}
