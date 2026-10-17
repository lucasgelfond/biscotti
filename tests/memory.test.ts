import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgent } from "../agent/src/agent.ts";
import { memories, openDb, transcripts } from "../agent/src/db.ts";
import { memoryTools } from "../agent/src/memory.ts";

// The production model through the AI Gateway (needs AI_GATEWAY_API_KEY; MODEL overrides it), and the
// on-device embeddings from tests/compose.yaml.
const MODEL = process.env.MODEL;
const EMBEDDINGS_URL = process.env.EMBEDDINGS_URL ?? "http://127.0.0.1:8092";

const newDataDir = () => mkdtempSync(join(tmpdir(), "biscotti-"));

// Starts the agent the way main.ts does, on the data directory a previous run may have left.
async function start(dir: string) {
  const db = openDb(join(dir, "biscotti.db"));
  const agent = await createAgent({ db, dir, model: MODEL, tools: memoryTools(db, EMBEDDINGS_URL) });
  return { db, agent };
}

test("replies to a greeting", async () => {
  const { agent } = await start(newDataDir());

  const reply = await agent.reply("hi!");

  expect(reply?.trim()).toBeTruthy();
});

test("remembers a fact and recalls it once the conversation is gone", async () => {
  const dir = newDataDir();
  const first = await start(dir);

  await first.agent.reply("My gym locker is number 4127, remember that.");
  const saved = first.db.select().from(memories).all();
  expect(saved.map((m) => m.content).join("\n")).toContain("4127");

  // As if compaction had summarized it all away: the answer can only come from recall.
  first.db.delete(transcripts).run();
  const second = await start(dir);
  const reply = await second.agent.reply("What's my gym locker number?");

  expect(reply).toContain("4127");
});

test("resumes the same conversation after a restart", async () => {
  const dir = newDataDir();
  const first = await start(dir);
  await first.agent.reply("Please call me Captain from now on.");

  const second = await start(dir);
  const reply = await second.agent.reply("What did I ask you to call me?");

  expect(reply).toContain("Captain");
});

test("keeps every message in the searchable transcript", async () => {
  const { db, agent } = await start(newDataDir());
  await agent.reply("The plumber is coming Thursday at 10.");

  const messages = db.select({ text: transcripts.text }).from(transcripts).all().flatMap((r) => r.text ?? []);
  const found = db.$client
    .prepare("SELECT t.text FROM transcripts_fts f JOIN transcripts t ON t.seq = f.rowid WHERE transcripts_fts MATCH 'plumber'")
    .all();

  expect(messages[0]).toContain("user: ");
  expect(messages[0]).toContain("The plumber is coming Thursday at 10.");
  expect(messages.some((m) => m.startsWith("assistant: "))).toBe(true);
  expect(found.length).toBeGreaterThan(0);
});
