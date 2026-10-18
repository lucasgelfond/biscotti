import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgent } from "../agent/src/agent.ts";
import { openDb, wakes } from "../agent/src/db.ts";
import { startWakes, wakeTools } from "../agent/src/wakes.ts";

const TIMEZONE = "America/New_York";
const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), "biscotti-")), "biscotti.db"));

test("turns 'remind me every Monday at 8pm' into a weekly wake", async () => {
  const db = newDb();
  const agent = await createAgent({ db, dir: mkdtempSync(join(tmpdir(), "biscotti-")), tools: wakeTools(db, TIMEZONE) });

  await agent.reply("Remind me every Monday at 8pm to call Mom.");

  const saved = db.select().from(wakes).all();
  expect(saved).toHaveLength(1);
  expect(saved[0].when).toBe("0 20 * * 1");
  expect(saved[0].prompt.toLowerCase()).toContain("mom");
});

test("fires a one-time wake once and keeps a repeating one", async () => {
  const db = newDb();
  const inTwoSeconds = new Date(Date.now() + 2000).toLocaleString("sv-SE", { timeZone: TIMEZONE }).replace(" ", "T");
  db.insert(wakes).values({ label: "once", when: inTwoSeconds, prompt: "Remind the owner to stretch" }).run();
  db.insert(wakes).values({ label: "every second", when: "* * * * * *", prompt: "Count" }).run();
  const fired: string[] = [];

  const timer = startWakes(db, TIMEZONE, async (wake) => void fired.push(wake.label), 200);
  await new Promise((r) => setTimeout(r, 3500));
  clearInterval(timer);

  const left = db.select().from(wakes).all().map((w) => w.label);
  expect(fired.filter((l) => l === "once")).toHaveLength(1);
  expect(fired.filter((l) => l === "every second").length).toBeGreaterThan(1);
  expect(left).toEqual(["every second"]);
});
