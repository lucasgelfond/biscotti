import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Llm, LlmCall, Plugin } from "@biscotti/core";
import { gateway, url as bifrostUrl } from "../bifrost/index.ts";
import { backend as claudeCode, claude, getClaudeStatus } from "../claude-code/index.ts";

// Model routing by NVIDIA's Switchyard (github.com/NVIDIA-NeMo/Switchyard, built from source by the Dockerfile: it
// publishes no image), with TypeSafe's Jev as the judge. The gate's calls for SWITCHYARD_ROLES (e.g. task, or
// main,task,code) and SWITCHYARD_ALIAS go to Switchyard at 127.0.0.1:4801, with a session per caller (the main agent,
// or each task, so a task keeps its model). At each new user message Jev picks one of TIERS by name (the names are the
// policy), and Switchyard serves that tier's first model, falling through the rest when one fails:
// DeepSeek and Qwen through LLM_BASE_URL (or Bifrost, when that plugin is on), Opus and Sonnet through Claude Code,
// which this plugin runs for Switchyard on 127.0.0.1:4802 (only Switchyard's key, derived from DB_KEY, gets in).
// When Switchyard is down or every model fails, the gate falls back to LLM_BASE_URL.
//
// Turning it on: SWITCHYARD_ROLES and SWITCHYARD_QWEN_MODEL (the gateway's id for Qwen) in .env, "switchyard" in
// biscotti.json (not alongside claude-code for the same roles), then restart setup and the gate. Jev is TypeSafe's
// /v1/systemone with TYPESAFE_API_KEY; through OpenRouter, set SWITCHYARD_JEV_URL, SWITCHYARD_JEV_KEY and
// SWITCHYARD_JEV_MODEL. Switchyard expects Jev's answers to carry `"type": "choice"` (not checked against the live API).

type Env = Record<string, string | undefined>;

export const PORT = 4801;
export const CLAUDE_PORT = 4802;
const url = (env: Env) => (env.SWITCHYARD_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const list = (s?: string) => (s ?? "").split(",").map((p) => p.trim()).filter(Boolean);

// What Switchyard sends Claude Code's port, so nothing else on the machine draws on the subscription through it.
export const claudeKey = (env: Env) => env.SWITCHYARD_CLAUDE_KEY || createHmac("sha256", env.DB_KEY ?? "").update("switchyard-claude").digest("hex");

export function roster(env: Env) {
  return {
    deepseek: env.SWITCHYARD_DEEPSEEK_MODEL || "deepseek/deepseek-v4.1-flash-1017-fast",
    // A placeholder: the gateway's id for Qwen 3.8 27B.
    qwen: env.SWITCHYARD_QWEN_MODEL || "qwen/qwen3.8-27b",
    sonnet: env.SWITCHYARD_SONNET_MODEL || "sonnet",
    opus: env.SWITCHYARD_OPUS_MODEL || "opus",
  };
}

// What Jev chooses between (each option's name is all it's told of it), cheapest first; each tier's first model
// serves, the rest are its fallbacks.
export const TIERS: Record<string, string[]> = {
  "simple (chat, lookups, short replies)": ["qwen", "deepseek"],
  "routine (browsing, tool use, everyday errands)": ["deepseek", "qwen"],
  "demanding (careful writing, coding, multi-step plans)": ["sonnet", "deepseek"],
  "hardest (deep reasoning, hard debugging, high stakes)": ["opus", "sonnet", "deepseek"],
};

// Switchyard's TOML. `bifrost`: the API-key models go through the Bifrost plugin's gateway rather than LLM_BASE_URL.
// Keys are named, not written: switchyard.env (secrets) holds them.
export function config(env: Env, bifrost = false) {
  const models = roster(env);
  const alias = env.SWITCHYARD_ALIAS || "auto";
  const trigger = env.SWITCHYARD_TRIGGER || "user_turn";
  const failOpen = /^(1|true|yes)$/i.test(env.SWITCHYARD_FAIL_OPEN ?? "");
  const jevUrl = env.SWITCHYARD_JEV_URL || `${(env.TYPESAFE_URL || "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`;
  // What Jev reads: the conversation's opening message and its last few (by default the new user message alone: a
  // longer window carries tool results, screenshots and all).
  const window = Number(env.SWITCHYARD_WINDOW || 1);
  const tiers = Object.keys(TIERS);
  const fallback = tiers.find((t) => t.startsWith(env.SWITCHYARD_DEFAULT || "routine")) ?? tiers[1];
  const route =
    (env.SWITCHYARD_ALGORITHM || "direct") === "task"
      ? {
          id: alias,
          type: "llm_classifier",
          mode: "capability",
          classifier_target: "judge",
          strong_target: env.SWITCHYARD_CAPABLE || "opus",
          weak_target: env.SWITCHYARD_EFFICIENT || "deepseek",
          classify_trigger: trigger,
          recent_turn_window: window,
          fail_open: failOpen,
          decision: { cutoff: Number(env.SWITCHYARD_CUTOFF || 0.6) },
        }
      : {
          id: alias,
          type: "llm_classifier",
          mode: "direct",
          default_target: fallback,
          classify_trigger: trigger,
          recent_turn_window: window,
          fail_open: failOpen,
          models: { judge: ["judge"], ...TIERS, any: ["deepseek", "qwen", "sonnet", "opus"] },
        };
  return {
    schema_version: 1,
    llm_clients: {
      gateway: { format: "openai_chat", base_url: bifrost ? `${bifrostUrl(env)}/v1` : env.LLM_BASE_URL, api_key_env: "SWITCHYARD_GATEWAY_KEY" },
      claude: { format: "openai_chat", base_url: `http://127.0.0.1:${env.SWITCHYARD_CLAUDE_PORT || CLAUDE_PORT}/v1`, api_key_env: "SWITCHYARD_CLAUDE_KEY" },
    },
    decision_clients: { jev: { format: "system_one", endpoint: jevUrl, api_key_env: "SWITCHYARD_JEV_KEY", timeout_ms: Number(env.SWITCHYARD_JEV_TIMEOUT_MS || 10_000) } },
    decision_targets: { judge: { id: env.SWITCHYARD_JEV_MODEL || env.TYPESAFE_MODEL || "jev-latest", decision_client: "jev" } },
    targets: {
      deepseek: { id: bifrost ? gateway(models.deepseek) : models.deepseek, llm_client: "gateway" },
      qwen: { id: bifrost ? gateway(models.qwen) : models.qwen, llm_client: "gateway" },
      sonnet: { id: models.sonnet, llm_client: "claude" },
      opus: { id: models.opus, llm_client: "claude" },
    },
    routes: { [alias]: route },
  };
}

// The keys switchyard.env gives the server, by the names config() gives them.
export function secrets(env: Env, bifrost = false) {
  if (!(env.SWITCHYARD_JEV_KEY || env.TYPESAFE_API_KEY)) throw new Error("switchyard: TYPESAFE_API_KEY (or SWITCHYARD_JEV_KEY) is needed for Jev");
  return {
    SWITCHYARD_GATEWAY_KEY: bifrost ? "unused" : (env.LLM_API_KEY ?? ""),
    SWITCHYARD_CLAUDE_KEY: claudeKey(env),
    SWITCHYARD_JEV_KEY: (env.SWITCHYARD_JEV_KEY || env.TYPESAFE_API_KEY)!,
  };
}

// Switchyard's session for a call: the main agent's, or the task the VM in its slot runs, so a task keeps its model.
export const session = (call: LlmCall) => (call.slot ? (call.task ? `biscotti-task-${call.task}` : `biscotti-slot-${call.slot}`) : "biscotti-main");

// Answers Switchyard gives because of the request itself, which LLM_BASE_URL would refuse too; any other failure is
// a 503, so the gate falls back.
const REQUEST_FAULTS = new Set([400, 413, 422]);

// The model that served a reply, from its first bytes (JSON or the first SSE chunk).
function served(response: Response, log: (model?: string) => void): Response {
  if (!response.body) return (log(), response);
  let head = "";
  let logged = false;
  const once = (model?: string) => !logged && ((logged = true), log(model));
  const decoder = new TextDecoder();
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        if (!logged) {
          head += decoder.decode(chunk, { stream: true });
          const model = head.match(/"model"\s*:\s*"([^"]+)"/)?.[1];
          if (model || head.length > 16_384) once(model);
        }
        out.enqueue(chunk);
      },
      flush: () => void once(head.match(/"model"\s*:\s*"([^"]+)"/)?.[1]),
    }),
  );
  return new Response(body, { status: response.status, headers: response.headers });
}

// Each routing decision: the gate's model name, the session, the model Switchyard picked (or why it couldn't), as a
// line in the gate's log and in `file` (JSONL).
export type Decision = { at: string; name: string; session: string; model?: string; status: number; error?: string };
export const logger = (file?: string) => (d: Decision) => {
  console.log(`switchyard: ${d.name} (${d.session}) -> ${d.model ?? `none (${d.status}${d.error ? `: ${d.error}` : ""})`}`);
  if (file) {
    try {
      appendFileSync(file, `${JSON.stringify(d)}\n`);
    } catch (err) {
      console.error("switchyard: the decision log:", err);
    }
  }
};

export function backend(env: Env = process.env, log = logger()): Llm {
  const alias = env.SWITCHYARD_ALIAS || "auto";
  const names = [alias, ...list(env.SWITCHYARD_ROLES)];
  return {
    models: Object.fromEntries(names.map((n) => [n, alias])),
    async complete(body, signal, call) {
      const decision = { at: new Date().toISOString(), name: call.name, session: session(call) };
      const down = (status: number, error: string) => {
        log({ ...decision, status, error });
        return Response.json({ error: { message: `switchyard: ${error}`, type: "switchyard" } }, { status: 503 });
      };
      let res: Response;
      try {
        res = await fetch(`${url(env)}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-switchyard-session-id": decision.session },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        return down(503, err instanceof Error ? err.message : String(err));
      }
      if (!res.ok && !REQUEST_FAULTS.has(res.status)) return down(res.status, (await res.text().catch(() => "")).slice(0, 500));
      return served(res, (model) => log({ ...decision, model, status: res.status }));
    },
  };
}

// Claude Code for Switchyard's Opus and Sonnet targets: an OpenAI-compatible port on 127.0.0.1 that runs `claude -p`
// as the claude-code plugin does. It never calls the gate's model, so nothing comes back to Switchyard.
export function claudePort(env: Env = process.env, claude: Llm = claudeCode(env), port = Number(env.SWITCHYARD_CLAUDE_PORT || CLAUDE_PORT)) {
  const expected = Buffer.from(`Bearer ${claudeKey(env)}`);
  const server = createServer(async (req, res) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.writeHead(401).end();
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const reply = await claude.complete(body, abort.signal, { name: String(body.model) });
      res.writeHead(reply.status, { "Content-Type": reply.headers.get("content-type") ?? "application/json" });
      for await (const chunk of reply.body ?? []) res.write(chunk);
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err), type: "claude_code" } }));
    }
  });
  return new Promise<Server>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server)));
}

export default {
  async llm(ctx) {
    // Without it, Switchyard's Claude tiers fall through to their other models.
    await claudePort().catch((err) => console.error(`switchyard: Claude Code's port: ${err}`));
    const llm = backend(process.env, logger(`${ctx.dir}/switchyard.jsonl`));
    console.log(`switchyard: answering ${Object.keys(llm.models).join(", ")}`);
    return llm;
  },
  async start() {
    const s = await getClaudeStatus({ ...process.env, PI_CLAUDE_CODE_COMMAND: claude() });
    if (!s.loggedIn) console.error(`switchyard: Claude Code isn't usable, so its tiers fall through to the API models. ${s.detail}`);
  },
} satisfies Plugin;
