import type { Llm, Plugin } from "@biscotti/core";

// Bifrost (github.com/maximhq/bifrost, compose.yaml) in front of LLM_BASE_URL: the gate's main, task and code calls go
// through it, with its retries and, per BIFROST_FALLBACKS (Bifrost's model names, e.g. backup/<model>), failover to
// other models or a second provider (BIFROST_BACKUP_URL, BIFROST_BACKUP_KEY). When it's down, the gate calls
// LLM_BASE_URL itself. A plugin listed after it in biscotti.json that answers the same models (claude-code) wins.

type Env = Record<string, string | undefined>;

// Bifrost's names for the providers it's given: the gateway (LLM_BASE_URL), and a backup (BIFROST_BACKUP_URL).
export const GATEWAY = "gateway";
export const BACKUP = "backup";
export const url = (env: Env) => (env.BIFROST_URL || "http://127.0.0.1:4800").replace(/\/$/, "");

const list = (s?: string) => (s ?? "").split(",").map((p) => p.trim()).filter(Boolean);

// An OpenAI-compatible provider at `base` (with its /v1), chat completions only.
function provider(base: string, key: string) {
  return {
    keys: [{ name: "key", value: key, models: ["*"], weight: 1 }],
    network_config: {
      base_url: base.replace(/\/$/, ""),
      default_request_timeout_in_seconds: 300,
      stream_idle_timeout_in_seconds: 300,
      max_retries: 2,
      retry_backoff_initial: 500,
      retry_backoff_max: 5000,
    },
    custom_provider_config: {
      base_provider_type: "openai",
      allowed_requests: { chat_completion: true, chat_completion_stream: true },
      request_path_overrides: { chat_completion: "/chat/completions", chat_completion_stream: "/chat/completions" },
    },
  };
}

// Bifrost's config.json: config.json is the whole configuration (no database, no request logs kept).
export function config(env: Env) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("bifrost: LLM_BASE_URL and LLM_API_KEY are needed");
  return {
    config_store: { enabled: false },
    logs_store: { enabled: false },
    client: { enable_logging: false, disable_content_logging: true },
    providers: {
      [GATEWAY]: provider(env.LLM_BASE_URL, env.LLM_API_KEY),
      ...(env.BIFROST_BACKUP_URL && env.BIFROST_BACKUP_KEY && { [BACKUP]: provider(env.BIFROST_BACKUP_URL, env.BIFROST_BACKUP_KEY) }),
    },
  };
}

// A model on the gateway, as Bifrost names it.
export const gateway = (model: string) => `${GATEWAY}/${model}`;

export function backend(env: Env = process.env): Llm {
  const models = { main: env.MODEL, task: env.TASK_MODEL, code: env.CODE_MODEL || env.TASK_MODEL };
  const extra = env.LLM_EXTRA ? JSON.parse(env.LLM_EXTRA) : undefined;
  const fallbacks = list(env.BIFROST_FALLBACKS);
  return {
    models: Object.fromEntries(Object.entries(models).flatMap(([name, model]) => (model ? [[name, gateway(model)]] : []))),
    async complete(body, signal) {
      return fetch(`${url(env)}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(extra && { "x-bf-passthrough-extra-params": "true" }) },
        body: JSON.stringify({ ...body, ...extra, ...(fallbacks.length && { fallbacks }) }),
        signal,
      }).catch((err) => Response.json({ error: { message: `bifrost: ${err instanceof Error ? err.message : err}`, type: "bifrost" } }, { status: 503 }));
    },
  };
}

export default {
  llm: async () => backend(),
} satisfies Plugin;
