import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { backend, models } from "../plugins/claude-code/index.ts";
import { frames } from "../plugins/claude-code/openai.ts";
import { fakeClaude, streamed } from "./fakes/claude.ts";

const PNG = "iVBORw0KGgo=";
const searchTool = { type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: ["string", "null"] } } } } };

const textReply = (text: string, extra: Record<string, unknown>[] = []) => [
  ...extra,
  ...streamed([
    { type: "message_start", message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 4) } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(4) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]),
  { type: "result", subtype: "success", is_error: false, num_turns: 1 },
];

// Thinking, then a call of the caller's tool; Claude Code would go on to run it (inertly) and stop at max turns.
const toolReply = streamed([
  { type: "message_start", message: { id: "msg_2", role: "assistant", content: [], usage: { input_tokens: 50, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Search it." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "mcp__gate__web_search", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"biscotti"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" },
]);

async function gateWith(command: string, env: Record<string, string> = {}, upstream = { url: "http://127.0.0.1:1", models: { main: "provider/main", task: "provider/task" } as Record<string, string> }) {
  const seen: { model: string; body: string }[] = [];
  const gate = createGate({ llm: { url: upstream.url, key: "unused" }, models: upstream.models, send: async () => {} });
  gate.serve(backend({ PATH: process.env.PATH, CLAUDE_CODE_COMMAND: command, CLAUDE_CODE_MODELS: "main=opus", CLAUDE_CONFIG_DIR: "/tmp/claude-config", ...env }));
  gate.observe({ llm: ({ model }) => (response) => void seen.push({ model, body: response.body }) });
  const server = await gate.listen("127.0.0.1", 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/chat/completions`;
  const post = (body: Record<string, unknown>) => fetch(url, { method: "POST", body: JSON.stringify(body) });
  return { post, seen, close: () => server.close() };
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

test("turns OpenAI messages into Claude Code frames: system, images, tool calls and their results", () => {
  const { system, frames: out } = frames([
    { role: "system", content: "You are biscotti." },
    { role: "user", content: [{ type: "text", text: "What's this?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
    { role: "assistant", content: "Let me look.", tool_calls: [{ id: "call|1", function: { name: "web_search", arguments: '{"query":"cat"}' } }] },
    { role: "tool", tool_call_id: "call|1", content: "A cat." },
    { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: "https://example.com/cat.png" } }] },
  ]);

  expect(system).toBe("You are biscotti.");
  expect(out).toEqual([
    {
      type: "user",
      shouldQuery: false,
      message: { role: "user", content: [{ type: "text", text: "What's this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "call_1", name: "mcp__gate__web_search", input: { query: "cat" } }] },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "A cat." }] },
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
    },
  ]);
  expect(() => frames([{ role: "user", content: "hi" }, { role: "assistant", content: "prefill" }])).toThrow();
});

test("answers a model call through claude -p, with the flags that keep it to talking to the model", async () => {
  const claude = fakeClaude(textReply("biscotti!"));
  const gate = await gateWith(claude.command);

  const res = await gate.post({ model: "main", max_tokens: 100, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say biscotti." }], tools: [searchTool] });
  const body = await res.json();
  gate.close();
  const [run, ...stdin] = claude.entries();

  expect(res.status).toBe(200);
  expect(body.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "biscotti!" }, finish_reason: "stop" });
  expect(body.usage).toEqual({ prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, prompt_tokens_details: { cached_tokens: 30 } });
  expect(body.model).toBe("opus");
  expect(run.args).toEqual(expect.arrayContaining(["-p", "--model", "opus", "--tools", "", "--max-turns", "1", "--strict-mcp-config", "--no-session-persistence"]));
  expect(run.args.slice(run.args.indexOf("--permission-mode"), run.args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
  expect(run.system).toBe("Be brief.");
  expect(run.tools).toEqual([{ name: "web_search", description: "Search the web.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }]);
  expect(run.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-config");
  expect(run.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("100");
  expect(run.env.LLM_API_KEY).toBeUndefined();
  expect(stdin.map((e) => e.frame.message)).toEqual([{ role: "user", content: [{ type: "text", text: "Say biscotti." }] }]);
  expect(gate.seen).toEqual([{ model: "opus", body: JSON.stringify(body) }]);
});

test("streams a tool call back as OpenAI chunks, stops Claude Code before it acts on it, and replays its thinking", async () => {
  const claude = fakeClaude(toolReply);
  const gate = await gateWith(claude.command);
  const ask = [{ role: "user", content: "Search for biscotti." }];

  const res = await gate.post({ model: "main", stream: true, messages: ask, tools: [searchTool] });
  const chunks = sse(await res.text());
  const deltas = chunks.slice(0, -1).map((c) => c.choices[0].delta);
  const call = deltas.flatMap((d) => d.tool_calls ?? []);
  await gate.post({
    model: "main",
    stream: true,
    messages: [...ask, { role: "assistant", content: null, reasoning_content: "Search it.", tool_calls: [{ id: "toolu_01", type: "function", function: { name: "web_search", arguments: '{"query":"biscotti"}' } }] }, { role: "tool", tool_call_id: "toolu_01", content: "Biscotti are twice-baked." }],
  });
  gate.close();
  const replayed = claude.entries().filter((e) => e.frame?.type === "assistant");

  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(deltas[0]).toEqual({ role: "assistant", content: "" });
  expect(deltas).toContainEqual({ reasoning_content: "Search it." });
  expect(call[0]).toEqual({ index: 0, id: "toolu_01", type: "function", function: { name: "web_search", arguments: "" } });
  expect(call.map((c) => c.function.arguments).join("")).toBe('{"query":"biscotti"}');
  expect(chunks.at(-2).choices[0].finish_reason).toBe("tool_calls");
  expect(chunks.at(-2).usage.completion_tokens).toBe(20);
  expect(chunks.at(-1)).toBe("[DONE]");
  expect(replayed[0].frame.message.content).toEqual([
    { type: "thinking", thinking: "Search it.", signature: "sig123" },
    { type: "tool_use", id: "toolu_01", name: "mcp__gate__web_search", input: { query: "biscotti" } },
  ]);
});

test("fails with a status of its own when Claude Code isn't logged in, isn't there, or hit its limit", async () => {
  const none = { url: "http://127.0.0.1:1", models: { task: "provider/task" } };
  const loggedOut = await gateWith(fakeClaude([], { loggedIn: false }).command, {}, none);
  const missing = await gateWith(join(tmpdir(), "no-such-claude"), {}, none);
  const limited = await gateWith(
    fakeClaude([
      { type: "assistant", error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "Claude AI usage limit reached|1763100000" }] } },
      { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1763100000" },
    ]).command,
    {},
    none,
  );
  const ask = { model: "main", stream: true, messages: [{ role: "user", content: "hi" }] };

  const responses = await Promise.all([loggedOut.post(ask), missing.post(ask), limited.post(ask)]);
  const said = await Promise.all(responses.map((r) => r.json()));
  for (const g of [loggedOut, missing, limited]) g.close();

  expect(responses.map((r) => r.status)).toEqual([503, 503, 429]);
  expect(said[0].error.message).toContain("claude auth login");
  expect(said[1].error.message).toContain("CLAUDE_CODE_COMMAND");
  expect(said[2].error.message).toContain("usage limit");
});

test("stops calling Claude Code once a reply is charged to usage credits instead of the plan", async () => {
  const overage = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: true, resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
  const gate = await gateWith(fakeClaude(textReply("hi", [overage])).command, {}, { url: "http://127.0.0.1:1", models: { task: "provider/task" } });

  const first = await gate.post({ model: "main", messages: [{ role: "user", content: "hi" }] });
  const second = await gate.post({ model: "main", messages: [{ role: "user", content: "hi again" }] });
  gate.close();

  expect(first.status).toBe(402);
  expect(second.status).toBe(402);
  expect((await second.json()).error.message).toContain("usage credits");
});

test("leaves the gate's other models to LLM_BASE_URL", async () => {
  const claude = fakeClaude(textReply("unused"));
  const gate = await gateWith(claude.command);

  const res = await gate.post({ model: "task", messages: [{ role: "user", content: "hi" }] });
  gate.close();

  expect(res.status).toBe(502);
  expect(claude.entries()).toEqual([]);
});

test("the inert MCP server lists the tools and runs none of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inert-"));
  writeFileSync(join(dir, "tools.json"), JSON.stringify([{ name: "web_search", description: "Search.", inputSchema: { type: "object", properties: {} } }]));
  const server = spawn(process.execPath, [new URL("../plugins/claude-code/inert-mcp.mjs", import.meta.url).pathname, join(dir, "tools.json")]);
  const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number, method: string) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
    return JSON.parse((await lines.next()).value).result;
  };

  const listed = await rpc(1, "tools/list");
  const called = await rpc(2, "tools/call");
  server.kill();

  expect(listed.tools.map((t: { name: string }) => t.name)).toEqual(["web_search"]);
  expect(called.isError).toBe(true);
});

// Against the real Claude Code, when it's installed and logged in here (CLAUDE_CODE_LIVE=1): one tiny call.
test.runIf(process.env.CLAUDE_CODE_LIVE)("calls a tool through the real Claude Code", async () => {
  const gate = createGate({ llm: { url: "http://127.0.0.1:1", key: "unused" }, models: {}, send: async () => {} });
  gate.serve(backend({ ...process.env, CLAUDE_CODE_MODELS: `main=${process.env.CLAUDE_CODE_MODEL ?? "haiku"}` }));
  const server = await gate.listen("127.0.0.1", 0);
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "main", stream: true, max_tokens: 200, messages: [{ role: "system", content: "Use the tools you're given." }, { role: "user", content: "Search the web for biscotti." }], tools: [searchTool] }),
  });
  const body = await res.text();
  server.close();
  console.log(body);
  const chunks = sse(body).filter((c) => c !== "[DONE]");

  expect(res.status).toBe(200);
  expect(chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? [])[0].function.name).toBe("web_search");
  expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
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
  const limited = fakeClaude([
    { type: "assistant", error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "Claude AI usage limit reached|1763100000" }] } },
    { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1763100000" },
  ]);
  const gate = await gateWith(limited.command, {}, { url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, models: { main: "provider/main" } });

  const first = await gate.post({ model: "main", messages: [{ role: "user", content: "hi" }] });
  const runs = limited.entries().length;
  const second = await gate.post({ model: "main", messages: [{ role: "user", content: "hi again" }] });
  gate.close();
  provider.close();

  expect(first.status).toBe(200);
  expect((await first.json()).choices[0].message.content).toBe("from the provider");
  expect(second.status).toBe(200);
  expect(asked).toEqual(["provider/main", "provider/main"]);
  expect(limited.entries().length).toBe(runs);
});
