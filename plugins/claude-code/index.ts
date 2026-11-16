import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { normalizeContext, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Message, type Model, type SimpleStreamOptions, type TextContent, type ThinkingContent, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Llm, Plugin } from "@biscotti/core";
import { createJiti } from "jiti";

// pi-claude-code ships TypeScript that Node won't run from node_modules; jiti loads it, as pi loads its extensions.
const jiti = createJiti(import.meta.url);
const from = <T>(file: string) => jiti.import<T>(`@earendil-works/pi-claude-code/src/${file}`);
const [{ getClaudeStatus }, { CLAUDE_CODE_MODELS, modelForDiscoveredRoute, API_ID, PROVIDER_ID }, { normalizeError, streamClaudeCode }] = await Promise.all([
  from<{ getClaudeStatus(env: Record<string, string | undefined>): Promise<{ loggedIn: boolean; plan?: string; detail?: string }> }>("claude-cli.ts"),
  from<{ CLAUDE_CODE_MODELS: Model<string>[]; modelForDiscoveredRoute(route: string): Model<string> | undefined; API_ID: string; PROVIDER_ID: string }>("model-catalog.ts"),
  from<{ normalizeError(error: unknown): string; streamClaudeCode(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions & { env?: Record<string, string | undefined> }): AssistantMessageEventStream }>("stream.ts"),
]);
export { getClaudeStatus };

// The gate's model calls through the owner's Claude subscription, by earendil's pi-claude-code
// (github.com/earendil-works/pi-claude-code): Claude Code (`claude -p`) only talks to the model, and the caller's tool
// calls come back to it. This file only turns the gate's OpenAI chat completions into pi's messages and back.
// It counts against the subscription's usage limits, as using Claude Code does; a call it can't serve (logged out,
// over the limit, usage credits) answers 402, 429 or 503, and the gate uses LLM_BASE_URL for a while instead.
//
// Turning it on: "claude-code" in biscotti.json and restart setup (the gate's container then keeps Claude Code's login
// in /var/lib/biscotti/claude, CLAUDE_CONFIG_DIR); then log in once, from the link it prints:
//   docker exec -it biscotti-gate-1 node plugins/claude-code/cli.ts auth login
// or put a `claude setup-token` token in .env as CLAUDE_CODE_OAUTH_TOKEN.
//
// CLAUDE_CODE_MODELS: which of the gate's models it answers, each `name` or `name=model` (opus, sonnet, haiku, a full
// id), default main,task,code; a bare name gets CLAUDE_CODE_MODEL, or Claude Code's own default.
// CLAUDE_CODE_CONCURRENCY: Claude Code processes at once (each takes a few hundred MB), default 4.

type Env = Record<string, string | undefined>;

export function models(env: Env) {
  const fallback = env.CLAUDE_CODE_MODEL || "default";
  return Object.fromEntries(
    (env.CLAUDE_CODE_MODELS || "main,task,code")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, model] = s.split("=").map((p) => p.trim());
        return [name, model || fallback];
      }),
  );
}

// The Claude Code executable this plugin brings (its postinstall, which would link it, doesn't run under pnpm), found
// once: looking costs a full process report.
let found: string | undefined;
export function claude(env: Env = process.env) {
  if (env.CLAUDE_CODE_COMMAND) return env.CLAUDE_CODE_COMMAND;
  return (found ??= bundled());
}
function bundled() {
  try {
    const pkg = createRequire(import.meta.url).resolve("@anthropic-ai/claude-code/package.json");
    const musl = process.platform === "linux" && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
    return join(dirname(createRequire(pkg).resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}${musl ? "-musl" : ""}/package.json`)), "claude");
  } catch {
    return "claude";
  }
}
// What pi-claude-code runs: claude-env.mjs, which hands Claude Code none of the gate's keys.
const environment = (env: Env) => ({ ...env, CLAUDE_CODE_REAL: claude(env), PI_CLAUDE_CODE_COMMAND: new URL("./claude-env.mjs", import.meta.url).pathname });

interface ChatMessage {
  role: string;
  content?: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { function: { name: string; description?: string; parameters?: object } }[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
}

// A reply's thinking, by its tool calls' ids, so the next call (which comes back as OpenAI messages, without it) can
// replay it, as Claude needs during a tool loop. Lost on a restart, which costs only that thinking.
const thoughts = new Map<string, ThinkingContent[]>();

function context(req: ChatRequest, model: string): Context {
  const text = (c: ChatMessage["content"]) => (typeof c === "string" ? c : (c ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n"));
  const parts = (c: ChatMessage["content"]): (TextContent | ImageContent)[] =>
    typeof c === "string"
      ? [{ type: "text", text: c }]
      : (c ?? []).flatMap((p): (TextContent | ImageContent)[] => {
          if (p.type === "text" && p.text) return [{ type: "text", text: p.text }];
          const image = p.type === "image_url" && /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url ?? "");
          return image ? [{ type: "image", mimeType: image[1], data: image[2] }] : [];
        });
  const names = new Map<string, string>();
  const messages: Message[] = [];
  const now = Date.now();
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: parts(m.content), timestamp: now });
    if (m.role === "tool") messages.push({ role: "toolResult", toolCallId: m.tool_call_id!, toolName: names.get(m.tool_call_id!) ?? "tool", content: parts(m.content), isError: false, timestamp: now });
    if (m.role !== "assistant") continue;
    const calls = m.tool_calls ?? [];
    for (const c of calls) names.set(c.id, c.function.name);
    const reply: AssistantMessage = {
      role: "assistant",
      content: [
        ...(calls[0] ? (thoughts.get(calls[0].id) ?? []) : []),
        ...(text(m.content) ? [{ type: "text" as const, text: text(m.content) }] : []),
        ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments || "{}") })),
      ],
      api: API_ID,
      provider: PROVIDER_ID,
      model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls.length ? "toolUse" : "stop",
      timestamp: now,
    };
    messages.push(reply);
  }
  const systemPrompt = req.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n\n");
  return { systemPrompt: systemPrompt || undefined, messages, tools: req.tools?.map((t) => ({ name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object" } })) };
}

// The gate falls back to LLM_BASE_URL on these.
const status = (message: string) => (/usage credits/i.test(message) ? 402 : /rate limit|usage limit|limit reached|too many/i.test(message) ? 429 : /context_length_exceeded/.test(message) ? 400 : 503);
const FINISH = { toolUse: "tool_calls", length: "length" } as Record<string, string>;

export function backend(env: Env = process.env): Llm {
  let running = 0;
  const queue: (() => void)[] = [];
  const max = Number(env.CLAUDE_CODE_CONCURRENCY || 4);
  return {
    models: models(env),
    async complete(body, signal) {
      const req = body as unknown as ChatRequest;
      const model = modelForDiscoveredRoute(req.model) ?? CLAUDE_CODE_MODELS.find((m) => m.id === req.model) ?? { ...CLAUDE_CODE_MODELS[0], id: req.model };
      if (running >= max) await new Promise<void>((r) => queue.push(r));
      running++;
      const stream = streamClaudeCode(model, normalizeContext(context(req, model.id)), { signal, env: environment(env), maxTokens: req.max_completion_tokens ?? req.max_tokens });
      const id = `chatcmpl-${Date.now()}`;
      const chunk = (delta: object, finish: string | null = null, usage?: object) => ({ id, object: "chat.completion.chunk", model: req.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage && { usage }) });
      const usage = (m: AssistantMessage) => ({ prompt_tokens: m.usage.input + m.usage.cacheRead + m.usage.cacheWrite, completion_tokens: m.usage.output, total_tokens: m.usage.totalTokens });
      const iterator = stream[Symbol.asyncIterator]();
      const release = () => (running--, queue.shift()?.());

      // Answers that fail before the reply starts get a status of their own (so the gate can fall back).
      let first = await iterator.next();
      while (!first.done && first.value.type === "start") first = await iterator.next();
      if (!first.done && first.value.type === "error") {
        release();
        const message = normalizeError(first.value.error.errorMessage ?? "Claude Code failed");
        return Response.json({ error: { message, type: "claude_code" } }, { status: status(message) });
      }
      async function* events() {
        try {
          if (!first.done) yield first.value;
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
        } finally {
          release();
        }
      }
      const toOpenAi = async function* () {
        let calls = 0;
        for await (const e of events()) {
          if (e.type === "text_delta") yield chunk({ content: e.delta });
          if (e.type === "toolcall_end") yield chunk({ tool_calls: [{ index: calls++, id: e.toolCall.id, type: "function", function: { name: e.toolCall.name, arguments: JSON.stringify(e.toolCall.arguments) } }] });
          if (e.type === "error") yield { error: { message: normalizeError(e.error.errorMessage ?? "Claude Code failed"), type: "claude_code" } };
          if (e.type !== "done") continue;
          const thinking = e.message.content.filter((c): c is ThinkingContent => c.type === "thinking");
          const call = e.message.content.find((c) => c.type === "toolCall");
          if (call && thinking.length) thoughts.set(call.id, thinking);
          for (const old of [...thoughts.keys()].slice(0, Math.max(0, thoughts.size - 500))) thoughts.delete(old);
          yield chunk({}, FINISH[e.reason] ?? "stop", usage(e.message));
        }
      };

      if (req.stream) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(out) {
            for await (const c of toOpenAi()) out.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
            out.enqueue(encoder.encode("data: [DONE]\n\n"));
            out.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      let content = "";
      const toolCalls: unknown[] = [];
      let finish = "stop";
      let used: object | undefined;
      for await (const c of toOpenAi()) {
        if ("error" in c) return Response.json(c, { status: status(c.error.message) });
        const choice = c.choices[0] as { delta: { content?: string; tool_calls?: unknown[] }; finish_reason: string | null };
        content += choice.delta.content ?? "";
        toolCalls.push(...(choice.delta.tool_calls ?? []));
        if (choice.finish_reason) [finish, used] = [choice.finish_reason, c.usage];
      }
      return Response.json({ id, object: "chat.completion", model: req.model, choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(toolCalls.length && { tool_calls: toolCalls }) }, finish_reason: finish }], usage: used });
    },
  };
}

export default {
  llm: async () => backend(),
  // Not awaited: it runs Claude Code, and the gate needn't wait for it to start.
  async start(ctx) {
    void getClaudeStatus(environment(process.env)).then(async (s) => {
      if (s.loggedIn) return void console.log(`claude-code: logged in${s.plan ? ` (${s.plan})` : ""}; answering ${Object.keys(models(process.env)).join(", ")}`);
      console.error(`claude-code: ${s.detail}`);
      await ctx.send(`The claude-code plugin can't reach Claude yet, so model calls through it fail. ${s.detail}`);
    }).catch((err) => console.error(`claude-code: ${(err as Error).message}`));
  },
} satisfies Plugin;
