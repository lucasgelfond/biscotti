import { localTools, text, type Plugin } from "@biscotti/core";
import { Cron } from "croner";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text as column } from "drizzle-orm/sqlite-core";

// Wakes: the agent saves a prompt for itself with a schedule; when it comes due, the prompt returns to the conversation
// as a message, so the agent does it (reminding the owner, or starting a task and summarizing) like anything texted.

const wakes = sqliteTable("wakes", {
  id: integer().primaryKey({ autoIncrement: true }),
  label: column().notNull(),
  // A cron expression, or a local date and time for once.
  when: column().notNull(),
  prompt: column().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastRun: integer("last_run", { mode: "timestamp" }),
});

type Wake = typeof wakes.$inferSelect;

const CHECK_MS = 30_000;
const timezone = process.env.TZ ?? "America/New_York";
const local = (d: Date | null | undefined) => d?.toLocaleString("en-US", { timeZone: timezone });

// The next time a wake is due after its last run (or its creation); null once a one-time wake has run.
const nextRun = (wake: Wake) => new Cron(wake.when, { timezone }).nextRun(wake.lastRun ?? wake.createdAt);

export default {
  prompt: `Wakes:
- For reminders and recurring work ("every Monday at 8pm…", "tomorrow at 9…"), \`schedule\` a prompt for your future
  self: a cron expression for repeats, a local date and time for once. Confirm the next time to the user.
- A message starting "Wake" is one coming due: do what it says (text a reminder, or start a task and summarize the
  report). It is your own note, not the user speaking.`,

  async tools({ db }) {
    db.run(sql`CREATE TABLE IF NOT EXISTS wakes (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, label text NOT NULL, "when" text NOT NULL, prompt text NOT NULL,
      created_at integer NOT NULL, last_run integer)`);
    return localTools([
      {
        name: "schedule",
        description: `Wake yourself up later with a prompt, once or on a schedule (times are in ${timezone}). When it's due, the prompt comes back to you as a message starting "Wake"; do what it says then.`,
        input: {
          type: "object",
          properties: {
            label: { type: "string", description: "A short name the owner would recognize, e.g. 'Monday call-mom reminder'." },
            when: {
              type: "string",
              description: "A cron expression for repeating wakes (e.g. '0 20 * * 1' is Mondays at 8pm), or a local date and time for once (e.g. '2026-10-20T09:00:00').",
            },
            prompt: { type: "string", description: "An instruction to your future self, e.g. 'Remind the owner to call Mom'." },
          },
          required: ["label", "when", "prompt"],
        },
        async run(args) {
          const { label, when, prompt } = args as { label: string; when: string; prompt: string };
          const next = new Cron(when, { timezone }).nextRun();
          if (!next) return text(`"${when}" never comes up again; give a future time or a cron expression.`);
          const [wake] = db.insert(wakes).values({ label, when, prompt }).returning().all();
          return text(`Scheduled wake ${wake.id} (${label}); next ${local(next)}.`);
        },
      },
      {
        name: "list_wakes",
        description: "List scheduled wakes with their next run.",
        input: { type: "object", properties: {} },
        async run() {
          const lines = db.select().from(wakes).all().map((w) => `[${w.id}] ${w.label} (${w.when}); next ${local(nextRun(w))}: ${w.prompt}`);
          return text(lines.length ? lines.join("\n") : "No wakes scheduled.");
        },
      },
      {
        name: "cancel_wake",
        description: "Cancel a scheduled wake by id (from list_wakes).",
        input: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        async run({ id }) {
          const deleted = db.delete(wakes).where(eq(wakes.id, id as number)).returning().all();
          return text(deleted.length ? `Cancelled wake ${id}.` : `No wake ${id}.`);
        },
      },
    ]);
  },

  // Hands each due wake to the conversation. One-time wakes are removed once they've run.
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
