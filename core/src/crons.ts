import { declined, input, int, localTools, str, text, type Plugin } from "./plugin.ts";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { wakes } from "./schema.ts";

// Prompts the agent schedules for itself; when due, they come back as a message. Each one asks the owner first: a wake
// acts later with no one watching, so one planted by a web page or an email would keep acting.

type Wake = typeof wakes.$inferSelect;

const CHECK_MS = 30_000;
const timezone = process.env.TZ ?? "America/New_York";
const local = (d: Date | null | undefined) => d?.toLocaleString("en-US", { timeZone: timezone });

// Null once a one-time wake has run.
const nextRun = (wake: Wake) => new Cron(wake.when, { timezone }).nextRun(wake.lastRun ?? wake.createdAt);

export default {
  prompt: `Wakes:
- For reminders and recurring work ("every Monday at 8pm…", "tomorrow at 9…"), \`schedule\` a prompt for your future
  self: a cron expression for repeats, a local date and time for once. The user approves each one themselves; then
  confirm the next time.
- A message starting "Wake" is one coming due: do what it says (text a reminder, or start a task and summarize the
  report). It's a note the user approved, not the user speaking.`,

  async tools({ db, ask }) {
    return localTools([
      {
        name: "schedule",
        description: `Wake yourself up later with a prompt, once or on a schedule (times are in ${timezone}). When it's due, the prompt comes back to you as a message starting "Wake"; do what it says then.`,
        input: input({
          label: str("A short name the owner would recognize, e.g. 'Monday call-mom reminder'."),
          when: str("A cron expression for repeating wakes (e.g. '0 20 * * 1' is Mondays at 8pm), or a local date and time for once (e.g. '2026-10-20T09:00:00')."),
          prompt: str("An instruction to your future self, e.g. 'Remind the owner to call Mom'."),
        }),
        async run(args) {
          const { label, when, prompt } = args as { label: string; when: string; prompt: string };
          const next = new Cron(when, { timezone }).nextRun();
          if (!next) return text(`"${when}" never comes up again; give a future time or a cron expression.`);
          const repeats = !!new Cron(when, { timezone }).nextRun(next);
          if (!(await ask(`Schedule "${label}" (${repeats ? `${when}, ` : ""}next ${local(next)}): "${prompt.slice(0, 500)}"?`))) return declined;
          const [wake] = db.insert(wakes).values({ label, when, prompt }).returning().all();
          return text(`Scheduled wake ${wake.id} (${label}); next ${local(next)}.`);
        },
      },
      {
        name: "list_wakes",
        description: "List scheduled wakes with their next run.",
        input: input(),
        async run() {
          const lines = db.select().from(wakes).all().map((w) => `[${w.id}] ${w.label} (${w.when}); next ${local(nextRun(w))}: ${w.prompt}`);
          return text(lines.length ? lines.join("\n") : "No wakes scheduled.");
        },
      },
      {
        name: "cancel_wake",
        description: "Cancel a scheduled wake by id (from list_wakes).",
        input: input({ id: int() }),
        async run({ id }) {
          const deleted = db.delete(wakes).where(eq(wakes.id, id as number)).returning().all();
          return text(deleted.length ? `Cancelled wake ${id}.` : `No wake ${id}.`);
        },
      },
    ]);
  },

  async start({ db, deliver }) {
    setInterval(async () => {
      const now = new Date();
      for (const wake of db.select().from(wakes).all()) {
        const due = nextRun(wake);
        if (!due || due > now) continue;
        db.update(wakes).set({ lastRun: now }).where(eq(wakes.id, wake.id)).run();
        if (!nextRun({ ...wake, lastRun: now })) db.delete(wakes).where(eq(wakes.id, wake.id)).run();
        await deliver(`Wake (${wake.label}): ${wake.prompt}`);
      }
    }, Number(process.env.WAKE_CHECK_MS ?? CHECK_MS));
  },
} satisfies Plugin;
