import type { Llm, Plugin } from "@biscotti/core";
import { bundledClaude, ClaudeError, run, status, type Config } from "./claude.ts";
import { frames, tools, translator, type ChatRequest } from "./openai.ts";

// The gate's model calls through the owner's Claude subscription, by the Claude Code CLI (see README.md).
// CLAUDE_CODE_MODELS: which of the gate's models it answers, each `name` or `name=claude-model`
// (default main,task,code); a bare name gets CLAUDE_CODE_MODEL, or Claude Code's own default.

export function models(env: Record<string, string | undefined>) {
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

export function config(env: Record<string, string | undefined>): Config {
  return {
    command: env.CLAUDE_CODE_COMMAND || bundledClaude() || "claude",
    configDir: env.CLAUDE_CONFIG_DIR,
    env,
    idleMs: Number(env.CLAUDE_CODE_IDLE_MS || 180_000),
    allowUsageCredits: /^(1|true|yes)$/i.test(env.CLAUDE_CODE_ALLOW_USAGE_CREDITS ?? ""),
  };
}

// At most `n` Claude Code processes at once (each is a few hundred MB); the rest wait their turn.
function limiter(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>) => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

const failure = (err: unknown) => {
  const status = err instanceof ClaudeError ? err.status : 502;
  return Response.json({ error: { message: err instanceof Error ? err.message : String(err), type: "claude_code" } }, { status });
};

export function backend(env: Record<string, string | undefined> = process.env): Llm {
  const cfg = config(env);
  const limit = limiter(Number(env.CLAUDE_CODE_CONCURRENCY || 4));
  return {
    models: models(env),
    async complete(body, signal) {
      const req = body as unknown as ChatRequest;
      let conversation: ReturnType<typeof frames>;
      try {
        conversation = frames(req.messages ?? []);
      } catch (err) {
        return Response.json({ error: { message: String(err instanceof Error ? err.message : err), type: "invalid_request" } }, { status: 400 });
      }
      const out = translator(req.model);
      const call = (onEvent: (e: Record<string, unknown>) => void) =>
        limit(() => run(cfg, { model: req.model, ...conversation, tools: tools(req), maxTokens: req.max_completion_tokens ?? req.max_tokens, signal, onEvent }));

      if (!req.stream) {
        try {
          await call((e) => void out.event(e));
          return Response.json(out.completion());
        } catch (err) {
          return failure(err);
        }
      }
      // The response starts with the reply's first event, so a call that fails before it gets a status of its own.
      const encoder = new TextEncoder();
      let sink!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (sink = c) });
      const send = (data: unknown) => sink.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
      let first!: () => void;
      const started = new Promise<void>((resolve) => (first = resolve));
      const done = call((e) => {
        for (const chunk of out.event(e)) send(chunk);
        first();
      });
      try {
        await Promise.race([started, done]);
      } catch (err) {
        return failure(err);
      }
      done.then(
        () => (send("[DONE]"), sink.close()),
        (err) => (send({ error: { message: err instanceof Error ? err.message : String(err), type: "claude_code" } }), sink.close()),
      );
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  };
}

export default {
  llm: async () => backend(),
  async start(ctx) {
    const s = await status(config(process.env));
    if (s.loggedIn) return void console.log(`claude-code: logged in${s.plan ? ` (${s.plan})` : ""}; answering ${Object.keys(models(process.env)).join(", ")}`);
    console.error(`claude-code: ${s.detail}`);
    await ctx.send(`The claude-code plugin can't reach Claude yet, so model calls through it fail. ${s.detail}`);
  },
} satisfies Plugin;
