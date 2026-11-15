import { afterAll, expect, test } from "vitest";
import { sqlBridge } from "../core/src/sql-bridge.ts";
import { model, requests } from "./stand-in-model.ts";

// The main agent on pi-durable, with the real gate and a stand-in model behind LLM_BASE_URL: a turn's answer reaches
// the owner, a tool call goes through the gate's MCP, the session's transcript reaches memory, and every turn is
// stored in pi-durable's own encrypted database.


const { boot } = await import("./support.ts");
afterAll(() => void model.close());

test("a turn on pi-durable: the answer reaches the owner, a tool call goes through the gate, and memory gets the transcript", async () => {
  const { say, sent, db, dir } = await boot([]);

  await say("hello there");
  expect(sent.at(-1)).toBe("echo: hello there");
  // biscotti's prompt and tools reached the model.
  expect(requests.at(-1)!.messages[0].role).toBe("system");
  expect(requests.at(-1)!.tools?.map((t) => t.function.name)).toContain("remember");

  await say("remember my cat is called Ziggy");
  expect(sent.at(-1)).toBe("saved");
  const facts = db.$client.prepare("SELECT content FROM memories").all() as { content: string }[];
  expect(facts.map((f) => f.content)).toContain("my cat is called Ziggy");

  // The transcript, as text, for memory's search.
  const said = (db.$client.prepare("SELECT text FROM transcripts WHERE session = 'main' AND text IS NOT NULL ORDER BY seq").all() as { text: string }[]).map((r) => r.text);
  expect(said.some((t) => t.startsWith("user: ") && t.includes("hello there"))).toBe(true);
  expect(said).toContain("assistant: echo: hello there");

  // pi-durable's state is in its own encrypted file, not the gate's database.
  const durable = sqlBridge(`${dir}/durable.db`, "test-key");
  const tables = ((await durable.handle({ op: "all", sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'" })) as { name: string }[]).map((t) => t.name);
  expect(tables.length).toBeGreaterThan(0);
  expect(db.$client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'pi_%'").get()).toEqual({ n: 0 });
  durable.close();
}, 60_000);
