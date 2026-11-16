import { afterAll, expect, test } from "vitest";
import { openEncrypted } from "../core/src/memory.ts";
import { localTools, type Plugin, text } from "../core/src/plugin.ts";
import { model, requests } from "./stand-in-model.ts";

// The main agent on pi-durable, with the real gate and a stand-in model behind LLM_BASE_URL: a turn's answer reaches
// the owner, a tool call goes through the gate's MCP, the session's transcript reaches memory, and every turn is
// stored in the agent's own database, under its own key.


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

  // pi-durable's state is in the agent's own file, under the agent's key: not the gate's database, nor its key.
  const durable = openEncrypted(`${dir}/durable.db`, "test-agent-key");
  expect((durable.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'pi_%'").get() as { n: number }).n).toBeGreaterThan(0);
  expect(db.$client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'pi_%'").get()).toEqual({ n: 0 });
  expect(() => openEncrypted(`${dir}/durable.db`, "test-key").prepare("SELECT count(*) FROM sqlite_master").get()).toThrow();
  durable.close();
}, 60_000);

test("a restarted gate (a new plugin's tools) is a new hello: the agent, still running, takes up its tools", async () => {
  const before = await boot([]);
  await before.say("hello there");
  const postcard: Plugin = { tools: async () => localTools([{ name: "send_postcard", description: "Send a postcard.", input: { type: "object" }, run: async () => text("sent") }]) };
  const after = await boot([postcard], { dir: before.dir, restart: before });

  await after.say("hello again");

  expect(after.sent.at(-1)).toBe("echo: hello again");
  expect(requests.at(-1)!.tools?.map((t) => t.function.name)).toContain("send_postcard");
}, 60_000);
