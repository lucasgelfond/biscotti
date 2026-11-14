import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { backend, models } from "../plugins/claude-code/index.ts";
import { calls, fakeClaude, says } from "./fakes/claude.ts";

// The claude-code plugin over a stand-in `claude`, through the gate as the main agent's calls go.
async function gateWith(command: string, upstream = { url: "http://127.0.0.1:1", models: { main: "provider/main", task: "provider/task" } as Record<string, string> }) {
  const gate = createGate({ llm: { url: upstream.url, key: "unused" }, models: upstream.models, send: async () => {} });
  gate.serve(backend({ PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_COMMAND: command, CLAUDE_CODE_MODELS: "main=opus", CLAUDE_CONFIG_DIR: "/tmp/claude-config", LLM_API_KEY: "the-gate-key" }));
  const server = await gate.listen("127.0.0.1", 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/chat/completions`;
  return { post: (body: Record<string, unknown>) => fetch(url, { method: "POST", body: JSON.stringify(body) }), close: () => server.close() };
}
const sse = (body: string) =>
  body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)));

test("picks the gate's models it answers, each with its Claude model", () => {
  expect(models({})).toEqual({ main: "default", task: "default", code: "default" });
  expect(models({ CLAUDE_CODE_MODELS: "main=opus, code", CLAUDE_CODE_MODEL: "sonnet" })).toEqual({ main: "opus", code: "sonnet" });
});

test("answers a model call through Claude Code, which gets none of the gate's keys", async () => {
  const claude = fakeClaude(says("Hello from Claude"));
  const gate = await gateWith(claude.command);
  const res = await gate.post({ model: "main", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] });
  gate.close();

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.choices[0]).toMatchObject({ message: { role: "assistant", content: "Hello from Claude" }, finish_reason: "stop" });
  const [run] = claude.runs();
  expect(run.env.LLM_API_KEY).toBeUndefined();
  expect(run.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-config");
  expect(run.args).toContain("-p");
});

test("streams a tool call back as OpenAI chunks, for the caller to run", async () => {
  const claude = fakeClaude(calls("web_search", { query: "biscotti" }));
  const gate = await gateWith(claude.command);
  const tools = [{ type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } } } } }];
  const res = await gate.post({ model: "main", stream: true, tools, messages: [{ role: "user", content: "look it up" }] });
  const chunks = sse(await res.text());
  gate.close();

  const call = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])[0];
  expect(call).toMatchObject({ type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "biscotti" }) } });
  expect(chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
  expect(chunks.at(-1)).toBe("[DONE]");
});

test("sends a call to LLM_BASE_URL when Claude Code hits its limit, and keeps doing so for a while", async () => {
  const asked: string[] = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    asked.push(JSON.parse(body).model);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the provider" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const limited = fakeClaude("Claude AI usage limit reached|1763100000");
  const gate = await gateWith(limited.command, { url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, models: { main: "provider/main" } });

  const first = await gate.post({ model: "main", messages: [{ role: "user", content: "hi" }] });
  const runs = limited.runs().length;
  const second = await gate.post({ model: "main", messages: [{ role: "user", content: "hi again" }] });
  gate.close();
  provider.close();

  expect((await first.json()).choices[0].message.content).toBe("from the provider");
  expect(second.status).toBe(200);
  expect(asked).toEqual(["provider/main", "provider/main"]);
  expect(limited.runs().length).toBe(runs);
});
