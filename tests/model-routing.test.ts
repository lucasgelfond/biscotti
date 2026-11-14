import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import type { Llm } from "../core/src/plugin.ts";
import * as bifrost from "../plugins/bifrost/index.ts";
import { backend as claudeCode } from "../plugins/claude-code/index.ts";
import * as switchyard from "../plugins/switchyard/index.ts";
import { parse, stringify as toml } from "smol-toml";
import { fakeClaude, says } from "./fakes/claude.ts";

// The bifrost and switchyard plugins against stand-ins for Bifrost, Switchyard, Jev and the gateway. With
// SWITCHYARD_BIN (a built switchyard-server) and BIFROST_BIN (bifrost-http), the real ones are run too.

type Seen = { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

// An OpenAI-compatible server answering `reply` (as SSE when asked to stream), with what it was sent in `seen`.
async function fake(reply: (body: Record<string, unknown>, seen: Seen) => { status?: number; json?: unknown } = (b) => ({ json: completion(String(b.model), "hi") })) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const entry = { url: req.url ?? "", headers: req.headers, body: text ? JSON.parse(text) : {} };
    seen.push(entry);
    const { status = 200, json } = reply(entry.body, entry);
    if (entry.body.stream && status === 200) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const c = json as ReturnType<typeof completion>;
      res.write(`data: ${JSON.stringify({ id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta: { role: "assistant", content: c.choices[0].message.content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: c.usage })}\n\n`);
      return void res.end("data: [DONE]\n\n");
    }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const completion = (model: string, content: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

// A gate whose LLM_BASE_URL is `direct`, serving `backends`; posts as the main agent, or as the VM in slot 1.
async function gateWith(direct: string, backends: Llm[], models: Record<string, string> = { main: "direct/main", task: "direct/task", code: "direct/task" }) {
  const gate = createGate({ llm: { url: `${direct}/v1`, key: "gateway-key" }, models, send: async () => {} });
  for (const b of backends) gate.serve(b);
  const main = await gate.listen("127.0.0.1", 0);
  const vm = await gate.listen("127.0.0.1", 0, { slot: 1 });
  const at = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/llm/chat/completions`;
  const post = (body: Record<string, unknown>, server = main) => fetch(at(server), { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) });
  return { gate, post, task: (body: Record<string, unknown> = {}) => post({ model: "anything", ...body }, vm), close: () => (main.close(), vm.close()) };
}

const decisions = () => {
  const seen: switchyard.Decision[] = [];
  return { seen, log: (d: switchyard.Decision) => void seen.push(d) };
};

describe("bifrost", () => {
  const env = { LLM_BASE_URL: "https://gateway.example/v1/", LLM_API_KEY: "gateway-key", MODEL: "deepseek/flash", TASK_MODEL: "deepseek/flash-task" };

  test("config.json: the gateway as an OpenAI-compatible provider, chat completions only, and a backup when set", () => {
    const c = bifrost.config(env);
    expect(c.providers.gateway).toMatchObject({
      keys: [{ value: "gateway-key", models: ["*"] }],
      network_config: { base_url: "https://gateway.example/v1", max_retries: 2 },
      custom_provider_config: { base_provider_type: "openai", request_path_overrides: { chat_completion: "/chat/completions" } },
    });
    expect(c.config_store).toEqual({ enabled: false });
    expect(Object.keys(c.providers)).toEqual(["gateway"]);
    expect(Object.keys(bifrost.config({ ...env, BIFROST_BACKUP_URL: "https://openrouter.ai/api/v1", BIFROST_BACKUP_KEY: "or" }).providers)).toEqual(["gateway", "backup"]);
    expect(() => bifrost.config({})).toThrow(/LLM_BASE_URL/);
  });

  test("the gate's calls go through Bifrost, with the fallbacks and LLM_EXTRA, and straight to LLM_BASE_URL when it's down", async () => {
    const proxy = await fake();
    const direct = await fake();
    const up = bifrost.backend({ ...env, BIFROST_URL: proxy.url, BIFROST_FALLBACKS: "gateway/qwen/qwen3.8-27b, backup/deepseek/flash", LLM_EXTRA: '{"providerOptions":{"gateway":{"order":["a"]}}}' });
    expect(up.models).toEqual({ main: "gateway/deepseek/flash", task: "gateway/deepseek/flash-task", code: "gateway/deepseek/flash-task" });
    const g = await gateWith(direct.url, [up]);

    expect((await g.post({ model: "main" })).status).toBe(200);
    expect(proxy.seen[0].url).toBe("/v1/chat/completions");
    expect(proxy.seen[0].headers["x-bf-passthrough-extra-params"]).toBe("true");
    expect(proxy.seen[0].body).toMatchObject({ model: "gateway/deepseek/flash", fallbacks: ["gateway/qwen/qwen3.8-27b", "backup/deepseek/flash"], providerOptions: { gateway: { order: ["a"] } } });
    expect(direct.seen).toEqual([]);

    proxy.close();
    const down = await g.post({ model: "task" });
    expect(down.status).toBe(200);
    expect(direct.seen.map((s) => [s.url, s.body.model, s.headers.authorization])).toEqual([["/v1/chat/completions", "direct/task", "Bearer gateway-key"]]);
    g.close();
    direct.close();
  });

});

describe("switchyard", () => {
  const env = { LLM_BASE_URL: "https://gateway.example/v1", LLM_API_KEY: "gateway-key", TYPESAFE_API_KEY: "ts-key", DB_KEY: "db" };

  test("switchyard.toml: four models in four tiers, Jev at TypeSafe as the judge, per user turn, no keys in it", () => {
    const config = switchyard.config(env);
    const text = toml(config);
    expect(parse(text)).toEqual(config);
    expect(config.llm_clients.gateway).toMatchObject({ format: "openai_chat", base_url: "https://gateway.example/v1", api_key_env: "SWITCHYARD_GATEWAY_KEY" });
    expect(config.llm_clients.claude).toMatchObject({ format: "openai_chat", base_url: "http://127.0.0.1:4802/v1" });
    expect(config.decision_clients.jev).toMatchObject({ format: "system_one", endpoint: "https://api.typesafe.ai/v1/systemone", api_key_env: "SWITCHYARD_JEV_KEY" });
    expect(config.targets.opus).toMatchObject({ id: "opus", llm_client: "claude" });
    expect(config.routes.auto).toMatchObject({ type: "llm_classifier", mode: "direct", default_target: "routine (browsing, tool use, everyday errands)", classify_trigger: "user_turn" });
    for (const secret of ["gateway-key", "ts-key"]) expect(text).not.toContain(secret);
  });

  test("through Bifrost, with Jev elsewhere (OpenRouter), or as Task routing between two models", () => {
    const via = switchyard.config({ ...env, SWITCHYARD_QWEN_MODEL: "qwen/real-id", SWITCHYARD_JEV_URL: "https://openrouter.ai/api/alpha/decisions", SWITCHYARD_JEV_MODEL: "typesafe/jev-1.13" }, true);
    expect(via.llm_clients.gateway.base_url).toBe("http://127.0.0.1:4800/v1");
    expect(via.targets.qwen.id).toBe("gateway/qwen/real-id");
    expect(via.targets.sonnet.id).toBe("sonnet");
    expect(via.decision_clients.jev.endpoint).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(via.decision_targets.judge.id).toBe("typesafe/jev-1.13");
    expect(switchyard.secrets({ ...env, SWITCHYARD_JEV_KEY: "or-key" }, true)).toEqual({ SWITCHYARD_GATEWAY_KEY: "unused", SWITCHYARD_CLAUDE_KEY: switchyard.claudeKey(env), SWITCHYARD_JEV_KEY: "or-key" });
    expect(() => switchyard.secrets({ LLM_API_KEY: "k" })).toThrow(/TYPESAFE_API_KEY/);

    const task = switchyard.config({ ...env, SWITCHYARD_ALGORITHM: "task", SWITCHYARD_ALIAS: "routed" }).routes.routed;
    expect(task).toMatchObject({ mode: "capability", classifier_target: "judge", strong_target: "opus", weak_target: "deepseek", decision: { cutoff: 0.6 } });
  });

  test("each call carries its session: the main agent's, or its task's, and each decision is logged", async () => {
    const server = await fake((b) => ({ json: completion(b.messages && JSON.stringify(b).includes("hard") ? "opus" : "gateway/deepseek/flash", "ok") }));
    const direct = await fake();
    const { seen, log } = decisions();
    const g = await gateWith(direct.url, [switchyard.backend({ SWITCHYARD_URL: server.url, SWITCHYARD_ROLES: "main,task,code" }, log)]);
    g.gate.assign(1, 42, "a goal");

    expect((await g.post({ model: "main" })).status).toBe(200);
    await (await g.task({ stream: true, messages: [{ role: "user", content: "something hard" }] })).text();
    g.gate.assign(1);
    await g.task();
    await g.post({ model: "auto" });

    expect(server.seen.map((s) => [s.body.model, s.headers["x-switchyard-session-id"]])).toEqual([
      ["auto", "biscotti-main"],
      ["auto", "biscotti-task-42"],
      ["auto", "biscotti-slot-1"],
      ["auto", "biscotti-main"],
    ]);
    expect(seen.map(({ name, session, model, status }) => ({ name, session, model, status }))).toEqual([
      { name: "main", session: "biscotti-main", model: "gateway/deepseek/flash", status: 200 },
      { name: "task", session: "biscotti-task-42", model: "opus", status: 200 },
      { name: "task", session: "biscotti-slot-1", model: "gateway/deepseek/flash", status: 200 },
      { name: "auto", session: "biscotti-main", model: "gateway/deepseek/flash", status: 200 },
    ]);
    expect(direct.seen).toEqual([]);
    g.close();
    server.close();
    direct.close();
  });

  test("Switchyard down, or failing (Jev or every model), is a 503: the gate falls back to LLM_BASE_URL", async () => {
    const failing = await fake(() => ({ status: 504, json: { error: { message: "decision deadline" } } }));
    const refusing = await fake(() => ({ status: 400, json: { error: { message: "bad request" } } }));
    const direct = await fake();
    const { seen, log } = decisions();
    const down = await gateWith(direct.url, [switchyard.backend({ SWITCHYARD_URL: "http://127.0.0.1:1", SWITCHYARD_ROLES: "main" }, log)]);
    const failed = await gateWith(direct.url, [switchyard.backend({ SWITCHYARD_URL: failing.url, SWITCHYARD_ROLES: "task" }, log)]);
    const refused = await gateWith(direct.url, [switchyard.backend({ SWITCHYARD_URL: refusing.url, SWITCHYARD_ROLES: "main" }, log)]);

    expect((await down.post({ model: "main" })).status).toBe(200);
    expect((await failed.task()).status).toBe(200);
    // The request's own fault: LLM_BASE_URL would refuse it too.
    expect((await refused.post({ model: "main" })).status).toBe(400);
    // The alias alone has nothing to fall back to.
    const auto = await down.post({ model: "auto" });

    expect(direct.seen.map((s) => s.body.model)).toEqual(["direct/main", "direct/task"]);
    expect(auto.status).toBe(503);
    expect(seen.map((d) => [d.status, d.model])).toEqual([[503, undefined], [504, undefined], [400, undefined], [503, undefined]]);
    expect(seen[1].error).toContain("decision deadline");
    for (const g of [down, failed, refused]) g.close();
    for (const s of [failing, refusing, direct]) s.close();
  });

  test("Claude Code's port: only for Switchyard's key, and it runs Claude Code, not the gate's model", async () => {
    const asked: unknown[] = [];
    const claude: Llm = { models: {}, complete: async (body) => (asked.push(body.model), Response.json(completion(String(body.model), "from claude"))) };
    const port = await switchyard.claudePort(env, claude, 0);
    const url = `http://127.0.0.1:${(port.address() as AddressInfo).port}/v1/chat/completions`;
    const post = (key: string) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "opus", messages: [] }) });

    expect((await post("wrong")).status).toBe(401);
    const ok = await post(switchyard.claudeKey(env));
    expect(await ok.json()).toMatchObject({ model: "opus", choices: [{ message: { content: "from claude" } }] });
    expect(asked).toEqual(["opus"]);
    port.close();
  });

  test("the decision log: a line per call in the gate's log and in a JSONL file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "decisions-")), "switchyard.jsonl");
    const log = switchyard.logger(file);
    log({ at: "t1", name: "main", session: "biscotti-main", model: "opus", status: 200 });
    log({ at: "t2", name: "task", session: "biscotti-task-3", status: 503, error: "connection refused" });

    expect(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { at: "t1", name: "main", session: "biscotti-main", model: "opus", status: 200 },
      { at: "t2", name: "task", session: "biscotti-task-3", status: 503, error: "connection refused" },
    ]);
  });

  test("inert unless named in biscotti.json: loading them starts nothing, and the gate answers as before", async () => {
    const direct = await fake();
    const g = await gateWith(direct.url, []);
    const claudePortUp = await fetch(`http://127.0.0.1:${switchyard.CLAUDE_PORT}/v1/chat/completions`, { method: "POST" }).then(() => true, () => false);

    expect((await g.post({ model: "main" })).status).toBe(200);
    expect(direct.seen.map((s) => s.body.model)).toEqual(["direct/main"]);
    expect(claudePortUp).toBe(false);
    g.close();
    direct.close();
  });
});

// The real services, on this machine: SWITCHYARD_BIN=…/switchyard-server BIFROST_BIN=…/bifrost-http npx vitest run model-routing
const until = async (url: string) => {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
};
const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  s.close();
  return port;
};

describe.skipIf(!process.env.SWITCHYARD_BIN || !process.env.BIFROST_BIN)("the real Switchyard and Bifrost", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-"));
  const procs: ChildProcess[] = [];
  const logs: string[] = [];
  let gateway: Awaited<ReturnType<typeof fake>>;
  let jev: Awaited<ReturnType<typeof fake>>;
  let env: Record<string, string>;
  let claudeServer: Server;
  // What Jev picks next (the tier's name starts with it), or a status to fail with.
  let pick: string | number = "routine";
  let claudeDown = false;
  const claude = fakeClaude(says("Opus here."));

  beforeAll(async () => {
    gateway = await fake();
    jev = await fake((body) => {
      if (typeof pick === "number") return { status: pick, json: { error: "unavailable" } };
      const options = Object.keys((body.questions as { route: { criteria: Record<string, unknown> } }).route.criteria);
      const choice = options.find((o) => o.startsWith(pick as string))!;
      return { json: { id: "d1", model: "jev-latest", answers: { route: { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.7 : 0.1])) } } } };
    });
    const [syPort, bfPort, claudePortNumber] = await Promise.all([freePort(), freePort(), freePort()]);
    env = {
      LLM_BASE_URL: `${gateway.url}/v1`,
      LLM_API_KEY: "gateway-key",
      MODEL: "deepseek/flash-direct",
      TASK_MODEL: "deepseek/flash-direct",
      TYPESAFE_URL: jev.url,
      TYPESAFE_API_KEY: "ts-key",
      DB_KEY: "db",
      BIFROST_URL: `http://127.0.0.1:${bfPort}`,
      SWITCHYARD_URL: `http://127.0.0.1:${syPort}`,
      SWITCHYARD_CLAUDE_PORT: String(claudePortNumber),
      SWITCHYARD_QWEN_MODEL: "qwen/qwen3.8-27b",
      SWITCHYARD_ROLES: "main,task",
      CLAUDE_CODE_COMMAND: claude.command,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      PATH: process.env.PATH!,
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bifrost.config(env)));
    writeFileSync(join(dir, "switchyard.toml"), toml(switchyard.config(env, true)));
    const run = (bin: string, args: string[], extra: Record<string, string> = {}) => {
      const p = spawn(bin, args, { env: { ...process.env, ...extra } });
      p.stdout?.on("data", (d) => logs.push(String(d)));
      p.stderr?.on("data", (d) => logs.push(String(d)));
      procs.push(p);
    };
    run(process.env.BIFROST_BIN!, ["-app-dir", dir, "-host", "127.0.0.1", "-port", String(bfPort)]);
    run(process.env.SWITCHYARD_BIN!, ["--config", join(dir, "switchyard.toml"), "--host", "127.0.0.1", "--port", String(syPort), "--routing-log-file", join(dir, "routing.jsonl")], switchyard.secrets(env, true));
    const real = claudeCode(env);
    const claudeOrDown: Llm = { models: {}, complete: (b, s, c) => (claudeDown ? Promise.resolve(Response.json({ error: { message: "not logged in" } }, { status: 503 })) : real.complete(b, s, c)) };
    claudeServer = await switchyard.claudePort(env, claudeOrDown, claudePortNumber);
    await Promise.all([until(`${env.BIFROST_URL}/health`), until(`${env.SWITCHYARD_URL}/health`)]);
  }, 60_000);

  afterAll(() => {
    for (const p of procs) p.kill();
    claudeServer?.close();
    gateway?.close();
    jev?.close();
  });

  test("Jev picks the tier, Switchyard serves it through Bifrost or Claude Code, and keeps it for the task's turn", async () => {
    const { seen, log } = decisions();
    const g = await gateWith(gateway.url, [bifrost.backend(env), switchyard.backend(env, log)]);
    g.gate.assign(1, 7, "goal");
    try {
      pick = "routine";
      const first = await g.task({ messages: [{ role: "user", content: "Book a table for two." }] });
      expect(first.status, logs.join("")).toBe(200);
      // A tool result continues the turn: no new decision.
      pick = "hardest";
      const tool = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browse", arguments: "{}" } }] };
      const continued = await (await g.task({ stream: true, messages: [{ role: "user", content: "Book a table for two." }, tool, { role: "tool", tool_call_id: "c1", content: "done" }] })).text();
      // The main agent's new message: Jev says the hardest tier, served by Claude Code, streamed.
      const opus = await g.post({ model: "main", stream: true, messages: [{ role: "user", content: "Prove this theorem." }] });
      const streamedText = await opus.text();

      expect(jev.seen.length).toBe(2);
      expect(jev.seen[0].headers.authorization).toBe("Bearer ts-key");
      expect(jev.seen[0].body).toMatchObject({ model: "jev-latest", questions: { route: { type: "choice" } } });
      expect(gateway.seen.map((s) => [s.url, s.body.model, s.headers.authorization])).toEqual([
        ["/v1/chat/completions", "deepseek/deepseek-v4.1-flash-1017-fast", "Bearer gateway-key"],
        ["/v1/chat/completions", "deepseek/deepseek-v4.1-flash-1017-fast", "Bearer gateway-key"],
      ]);
      expect(gateway.seen[1].body.stream).toBe(true);
      expect(continued).toContain('"content":"hi"');
      expect(streamedText).toContain("Opus here.");
      expect(claude.runs().some((e) => e.args.join(" ").includes("opus"))).toBe(true);
      expect(seen.map((d) => [d.name, d.session, d.model])).toEqual([
        ["task", "biscotti-task-7", expect.stringContaining("deepseek")],
        ["task", "biscotti-task-7", expect.stringContaining("deepseek")],
        ["main", "biscotti-main", "opus"],
      ]);
      expect(readFileSync(join(dir, "routing.jsonl"), "utf8")).toContain("biscotti-task-7");

      // Claude Code logged out: the hardest tier falls through Sonnet to DeepSeek.
      claudeDown = true;
      const through = await g.post({ model: "main", messages: [{ role: "user", content: "Another hard one." }] });
      expect(through.status).toBe(200);
      expect(gateway.seen.length).toBe(3);
      expect(seen.at(-1)!.model).toContain("deepseek");

      // Jev down: a 503, and the gate's call goes to Bifrost, the gate's upstream.
      pick = 500;
      const fallback = await g.post({ model: "main", messages: [{ role: "user", content: "Another question." }] });
      expect(fallback.status).toBe(200);
      expect(gateway.seen.at(-1)!.body.model).toBe("deepseek/flash-direct");
      expect(seen.at(-1)!.status).toBeGreaterThanOrEqual(500);
    } finally {
      g.close();
    }
  }, 60_000);
});
