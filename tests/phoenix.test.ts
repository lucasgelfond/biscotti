import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { localTools, text } from "../core/src/plugin.ts";
import { observer, tracerFor } from "../plugins/phoenix/index.ts";

const CARD = "4242424242424242";

// A model that streams "Hello there" and its token counts, as OpenAI-compatible APIs do.
async function fakeModel() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of [{ choices: [{ delta: { content: "Hello" } }] }, { choices: [{ delta: { content: " there" } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }])
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function tracedGate(exporter: SpanExporter = new InMemorySpanExporter()) {
  const { tracer, provider } = tracerFor(exporter);
  const gate = createGate({ llm: { url: await fakeModel(), key: "k" }, models: { main: "big-model", task: "small-model" }, send: async () => {}, secrets: () => [{ label: "Visa.number", value: CARD }] });
  gate.add({ ...localTools([{ name: "card_note", description: "", input: { type: "object" }, run: async () => text(`on file: ${CARD}`) }]), tasks: localTools([]) });
  gate.observe(observer(tracer));
  const main = await gate.listen("127.0.0.1", 0);
  const task = await gate.listen("127.0.0.1", 0, { slot: 1 });
  const url = (s: typeof main) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const spans = async () => (await provider.forceFlush(), (exporter as InMemorySpanExporter).getFinishedSpans?.() ?? []);
  return { main: url(main), task: url(task), spans };
}

const chat = (gate: string, content: string) =>
  fetch(`${gate}/llm/chat/completions`, { method: "POST", body: JSON.stringify({ model: "main", stream: true, messages: [{ role: "user", content }] }) }).then((r) => r.text());

test("traces a model call: the prompt with secrets as placeholders, the streamed reply and its tokens", async () => {
  const { main, spans } = await tracedGate();

  expect(await chat(main, `My card is ${CARD}`)).toContain("Hello");

  const [span] = await spans();
  expect(span.name).toBe("llm big-model");
  expect(span.attributes["openinference.span.kind"]).toBe("LLM");
  expect(span.attributes["llm.input_messages.0.message.content"]).toBe("My card is [vault:Visa.number]");
  expect(span.attributes["llm.output_messages.0.message.content"]).toBe("Hello there");
  expect(span.attributes["llm.token_count.total"]).toBe(14);
  expect(JSON.stringify(span.attributes)).not.toContain(CARD);
});

test("traces a tool call, its result scrubbed like a model call", async () => {
  const { main, spans } = await tracedGate();
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${main}/mcp`)));

  const result = await client.callTool({ name: "card_note", arguments: {} });

  // What the agent gets is unchanged; only the trace is scrubbed.
  expect(JSON.stringify(result)).toContain(CARD);
  const [span] = await spans();
  expect(span.attributes["openinference.span.kind"]).toBe("TOOL");
  expect(span.attributes["output.value"]).toBe("on file: [vault:Visa.number]");
});

test("groups a task VM's model calls under one task", async () => {
  const { task, spans } = await tracedGate();

  await chat(task, "Find showtimes");
  await chat(task, "Keep going");

  const llms = (await spans()).filter((s) => s.name === "llm small-model");
  expect(llms).toHaveLength(2);
  expect(llms[0].attributes["biscotti.slot"]).toBe(1);
  expect(llms[0].parentSpanContext?.spanId).toBeTruthy();
  expect(llms[1].parentSpanContext?.spanId).toBe(llms[0].parentSpanContext?.spanId);
});

// Against a running Phoenix, e.g. `PHOENIX_URL=http://127.0.0.1:6006`.
test.skipIf(!process.env.PHOENIX_URL)("Phoenix takes the spans, under the biscotti project", async () => {
  const { main, spans } = await tracedGate(new OTLPTraceExporter({ url: `${process.env.PHOENIX_URL}/v1/traces` }));
  const marker = `ping ${Date.now()}`;

  await chat(main, marker);
  await spans();

  // Phoenix writes what it's sent a moment later.
  const named = async () => {
    const { data } = await (await fetch(`${process.env.PHOENIX_URL}/v1/projects/biscotti/spans?limit=50`)).json();
    return data.find((s: { attributes: Record<string, unknown> }) => JSON.stringify(s.attributes).includes(marker))?.name;
  };
  await expect.poll(named, { timeout: 10_000 }).toBe("llm big-model");
});

test("keeps only what's new in a conversation since its last model call, and tools by name", async () => {
  const { task, spans } = await tracedGate();
  const call = (messages: { role: string; content: string }[]) =>
    fetch(`${task}/llm/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "task", stream: true, messages, tools: [{ type: "function", function: { name: "browser_click", parameters: { type: "object" } } }] }),
    }).then((r) => r.text());
  const first = [{ role: "system", content: "You are a task agent." }, { role: "user", content: "Find showtimes" }];
  await call(first);
  await call([...first, { role: "assistant", content: "Opening the site." }, { role: "tool", content: `page ${"x".repeat(10_000)}` }]);

  const [a, b] = (await spans()).filter((s) => s.name === "llm small-model");
  expect(a.attributes["llm.input_messages.1.message.content"]).toBe("Find showtimes");
  expect(b.attributes["biscotti.earlier_messages"]).toBe(2);
  expect(b.attributes["llm.input_messages.0.message.content"]).toBe("Opening the site.");
  expect(String(b.attributes["llm.input_messages.1.message.content"]).length).toBeLessThan(4_200);
  expect(b.attributes["llm.input_messages.2.message.content"]).toBeUndefined();
  expect(b.attributes["biscotti.tools"]).toBe("browser_click");
  expect(Object.keys(b.attributes).some((k) => k.startsWith("llm.tools."))).toBe(false);
});
