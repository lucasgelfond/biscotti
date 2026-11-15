import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import { sqlBridge } from "../core/src/sql-bridge.ts";

// The main agent on pi-durable, with the real gate and a stand-in model behind LLM_BASE_URL: a turn's answer reaches
// the owner, a tool call goes through the gate's MCP, the session's transcript reaches memory, and every turn is
// stored in pi-durable's own encrypted database.

// The stand-in model, OpenAI chat completions streamed: "remember X" calls the remember tool, a tool result is
// answered with "saved", anything else is echoed.
const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
const model = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body) as (typeof requests)[number];
  requests.push(request);
  const last = request.messages.at(-1)!;
  const said = typeof last.content === "string" ? last.content : (last.content as { text?: string }[]).map((p) => p.text ?? "").join("");
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage && { usage }) })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const remember = said.match(/remember (.+)$/)?.[1];
  if (last.role === "tool") res.write(chunk({ role: "assistant", content: "saved" }) + chunk({}, "stop", { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 }));
  else if (remember)
    res.write(
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: remember }) } }] }) +
        chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    );
  else res.write(chunk({ role: "assistant", content: `echo: ${said.replace(/^\[[^\]]*\] /, "")}` }) + chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }));
  res.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await once(model, "listening");
Object.assign(process.env, {
  LLM_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  LLM_API_KEY: "stand-in",
  MODEL: "stand-in/model",
  TASK_MODEL: "stand-in/model",
  DB_KEY: "test-key",
});
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
