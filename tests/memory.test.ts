import { expect, test } from "vitest";
import { memories, transcripts } from "../core/src/schema.ts";
import { boot, newDataDir } from "./support.ts";

const PLUGINS = ["embedding"];

test("replies to a greeting", async () => {
  const biscotti = await boot([]);

  await biscotti.say("hi!");

  expect(biscotti.sent.join("").trim()).toBeTruthy();
});

test("remembers a fact and recalls it once the conversation is gone", async () => {
  const dir = newDataDir();
  const first = await boot(PLUGINS, dir);

  await first.say("My gym locker is number 4127, remember that.");
  const saved = first.db.select().from(memories).all();
  expect(saved.map((m) => m.content).join("\n")).toContain("4127");

  // As if compaction had summarized it all away: the answer can only come from recall.
  first.db.delete(transcripts).run();
  const second = await boot(PLUGINS, dir);
  await second.say("What's my gym locker number?");

  expect(second.sent.join("\n")).toContain("4127");
});

test("recalls by meaning, not just by keyword", async () => {
  const dir = newDataDir();
  const first = await boot(PLUGINS, dir);
  await first.say("Remember: I'm allergic to peanuts.");
  first.db.delete(transcripts).run();

  const second = await boot(PLUGINS, dir);
  await second.say("Is satay sauce safe for me to eat?");

  expect(second.sent.join("\n").toLowerCase()).toMatch(/peanut|allerg/);
});

test("resumes the same conversation after a restart", async () => {
  const dir = newDataDir();
  const first = await boot([], dir);
  await first.say("Please call me Captain from now on.");

  const second = await boot([], dir);
  await second.say("What did I ask you to call me?");

  expect(second.sent.join("\n")).toContain("Captain");
});

test("keeps every message in the searchable transcript", async () => {
  const { db, say } = await boot([]);
  await say("The plumber is coming Thursday at 10.");

  const messages = db.select({ text: transcripts.text }).from(transcripts).all().flatMap((r) => r.text ?? []);
  const found = db.$client
    .prepare("SELECT t.text FROM transcripts_fts f JOIN transcripts t ON t.seq = f.rowid WHERE transcripts_fts MATCH 'plumber'")
    .all();

  expect(messages[0]).toContain("user: ");
  expect(messages[0]).toContain("The plumber is coming Thursday at 10.");
  expect(messages.some((m) => m.startsWith("assistant: "))).toBe(true);
  expect(found.length).toBeGreaterThan(0);
});

test("reacts with a tapback when asked", async () => {
  const biscotti = await boot([]);

  await biscotti.say("Just give my message a thumbs up tapback, no need to reply.");

  expect(biscotti.reactions).toContain("👍");
});
