import { expect, test } from "vitest";
import { boot } from "./support.ts";

const TIMEZONE = "America/New_York";
type Wake = { label: string; when: string; prompt: string };

test("turns 'remind me every Monday at 8pm' into a weekly wake", async () => {
  const biscotti = await boot([]);

  await biscotti.say("Remind me every Monday at 8pm to call Mom.");

  const saved = biscotti.db.$client.prepare("SELECT * FROM wakes").all() as Wake[];
  expect(saved).toHaveLength(1);
  expect(saved[0].when).toBe("0 20 * * 1");
  expect(saved[0].prompt.toLowerCase()).toContain("mom");
});

test("texts a reminder when a one-time wake comes due, then removes it", async () => {
  process.env.WAKE_CHECK_MS = "500";
  const biscotti = await boot([]);
  const inTwoSeconds = new Date(Date.now() + 2000).toLocaleString("sv-SE", { timeZone: TIMEZONE }).replace(" ", "T");
  biscotti.db.$client
    .prepare("INSERT INTO wakes (label, \"when\", prompt, created_at) VALUES (?, ?, ?, ?)")
    .run("stretch", inTwoSeconds, "Remind the owner to stretch", Math.floor(Date.now() / 1000));

  await expect.poll(() => biscotti.sent.join("\n").toLowerCase(), { timeout: 60_000 }).toContain("stretch");

  const left = biscotti.db.$client.prepare("SELECT * FROM wakes").all();
  expect(left).toEqual([]);
});
