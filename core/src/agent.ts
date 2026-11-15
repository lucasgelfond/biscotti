import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  type Conversation,
  type ConversationId,
  type ToolExecutionResult,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  section,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { listen, readBody } from "./http.ts";
import { RemoteSqliteDatabase, type SqlRequest } from "./sql-bridge.ts";

// The main agent: pi-durable runs every conversation, each turn and tool call committed before it shows, so a run a
// crash or restart cut off picks up where it was. It holds no keys and has no network: its storage (the gate's
// encrypted database), its model, biscotti's tools and the system prompt all come through the gate's socket, and the
// gate hands it each turn on the agent's own socket. Sessions: "main" (the owner's texts) and the others by number.

const ctx = BACKGROUND_CONTEXT;
const MAIN_MODEL = { provider: "biscotti", modelId: "main" } as const;

// Which conversation each session is.
const Sessions = defineDoc<{ ids: Record<string, string> }>({
  kind: "biscotti.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
  checkpointWhen: () => true,
});

export async function runAgent(sockets: string, _dir?: string) {
  const relay = createTcpServer((client) => {
    const gate = connect(`${sockets}/gate.sock`);
    client.pipe(gate).pipe(client);
    gate.on("error", () => client.destroy());
    client.on("error", () => gate.destroy());
  });
  const port = await new Promise<number>((resolve) => relay.listen(0, "127.0.0.1", () => resolve((relay.address() as { port: number }).port)));
  const gateUrl = `http://127.0.0.1:${port}`;

  // The gate, with no time limit (a tool call may wait minutes on the owner's yes).
  const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d: string) => (text += d)).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  // Retried while the gate is starting.
  const get = async (path: string) => {
    for (;;) {
      const res = await call("GET", path).catch(() => undefined);
      if (res && res.status < 300) return res.text;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const event = (session: string, e: unknown) => void call("POST", `/event?session=${encodeURIComponent(session)}`, JSON.stringify(e)).catch(() => {});

  // biscotti's tools, as the gate lists them, each call stamped with its conversation's session. A remote service's
  // (GitHub's, Notion's) the gate marks deferred: tool_search loads them when they're wanted.
  const mcp = async (session: string, method: string, params: object) => {
    const res = await call("POST", `/mcp?session=${encodeURIComponent(session)}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    const data = res.text.match(/^data: (.*)$/m)?.[1] ?? res.text;
    const reply = JSON.parse(data) as { result?: unknown; error?: { message: string } };
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };
  const sessionOf = new Map<string, string>();
  async function biscotti() {
    const prompt = await get("/prompt");
    const { tools } = (await mcp("main", "tools/list", {})) as { tools: { name: string; description?: string; inputSchema: object; _meta?: Record<string, unknown> }[] };
    return defineExtension({
      name: "biscotti",
      sections: [section("biscotti", () => prompt, { tag: false })],
      tools: tools.map((t) =>
        defineTool({
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema,
          ...(t._meta?.["biscotti/deferred"] ? { deferred: true as const } : {}),
          execute: async (args, api): Promise<ToolExecutionResult> => {
            const result = (await mcp(sessionOf.get(String(api.conversationId)) ?? "main", "tools/call", { name: t.name, arguments: args })) as {
              content: { type: string; text?: string; data?: string; mimeType?: string }[];
              isError?: boolean;
            };
            const output: unknown[] = result.content.flatMap((c): unknown[] =>
              c.type === "text" ? [{ type: "text", text: c.text ?? "" }] : c.type === "image" ? [{ type: "image", data: c.data, mimeType: c.mimeType }] : [],
            );
            return { output: output as unknown as ToolExecutionResult["output"], isError: result.isError };
          },
        }),
      ),
    });
  }

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "biscotti",
      baseUrl: `${gateUrl}/llm`,
      auth: { apiKey: { name: "the gate", resolve: async () => ({ auth: { apiKey: "added-by-the-gate" } }) } },
      models: [
        {
          id: "main",
          name: "main",
          api: "openai-completions",
          provider: "biscotti",
          baseUrl: `${gateUrl}/llm`,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_768,
          // A plain OpenAI-compatible endpoint (the gate, in front of DeepSeek and others): a system role, no store.
          compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  const registry = createRegistry();
  registry.install(await biscotti());
  registry.install(createToolSearchExtension());

  const database = new RemoteSqliteDatabase(async (req: SqlRequest) => {
    const res = await call("POST", "/sql", JSON.stringify(req), { "content-type": "application/json" });
    if (res.status >= 300) throw new Error(`the gate's database: ${res.text}`);
    return (JSON.parse(res.text) as { answer?: unknown }).answer;
  });

  // Open (and reopen, after the gate restarts mid-commit) over the gate's database; resume what was running.
  const conversations = new Map<string, Promise<Conversation>>();
  let harness!: Harness;
  async function open() {
    harness = await Harness.open(
      await SqliteStorage.open(database, { prefix: "pi_" }),
      {
        models,
        registry,
        settings: { compaction: { reserveTokens: 16_384 } },
        onReport: (report) => console.error(`pi-durable: ${report.kind}${report.error ? `: ${String(report.error)}` : ""}`),
      },
      ctx,
    );
    harness.resume();
    void harness.closed.then(async (end) => {
      if (end.kind !== "failed") return;
      conversations.clear();
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await open().then(() => true, () => false)) return;
      }
    });
  }
  await open();

  // A session's conversation: created once (the owner's texts are the root), then found by its session.
  function conversation(session: string) {
    let found = conversations.get(session);
    if (!found) {
      found = (async () => {
        const ids = (await harness.snapshot(Sessions, ctx))?.ids ?? {};
        let handle: Conversation | undefined = ids[session] ? await harness.conversation(ids[session] as unknown as ConversationId, ctx) : undefined;
        if (!handle) {
          handle =
            session === "main"
              ? await harness.root(ctx, { agent: { model: MAIN_MODEL } })
              : await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MAIN_MODEL } }, ctx);
          const id = String(handle.id);
          await harness.commit(async (tx) => void ((await tx.doc(Sessions)).ids[session] = id), ctx);
        }
        sessionOf.set(String(handle.id), session);
        void follow(session, handle);
        return handle;
      })();
      conversations.set(session, found);
      found.catch(() => conversations.delete(session));
    }
    return found;
  }

  // What each session does, as it's committed: for the owner's apps (a tool call starting, a message finished) and
  // for memory (the gate's searchable transcript).
  async function follow(session: string, handle: Conversation) {
    const seen = new Set<string>();
    const watch = await handle.watch(ctx);
    const take = async (entries: readonly { id: string; kind: string; model?: readonly { role: string; content: unknown }[] }[]) => {
      const rows: { id: string; entry: unknown; text: string | null }[] = [];
      for (const entry of entries) {
        if (seen.has(String(entry.id))) continue;
        seen.add(String(entry.id));
        const message = entry.model?.[0];
        if (!message) continue;
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as { type: string; text?: string; name?: string; arguments?: unknown }[]);
        const said = parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n").trim();
        if (message.role === "assistant") {
          for (const p of parts) if (p.type === "toolCall") event(session, { type: "tool_execution_start", toolName: p.name, args: p.arguments });
          if (said) event(session, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: said }] } });
        }
        rows.push({ id: entry.id, entry, text: said && (message.role === "user" || message.role === "assistant") ? `${message.role}: ${said}` : null });
      }
      if (rows.length) await call("POST", `/transcript?session=${encodeURIComponent(session)}`, JSON.stringify(rows)).catch(() => {});
    };
    for (const entry of watch.value.entries) seen.add(String(entry.id));
    watch.start(async (c) => {
      if (c.kind === "value") await take(c.value.entries as never);
    });
  }

  // Its model, thinking level and how full its context is, for the owner's apps, after each turn.
  async function status(session: string, handle: Conversation) {
    const agent = await handle.agent(ctx);
    const context = await handle.context(ctx);
    const last = [...context.messages].reverse().find((m) => m.role === "assistant") as { usage?: { input: number; cacheRead?: number; output: number } } | undefined;
    const tokens = last?.usage ? last.usage.input + (last.usage.cacheRead ?? 0) + last.usage.output : null;
    const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
    event(session, { type: "status", model: agent.model?.modelId ?? "main", thinking: agent.thinkingLevel, context: { tokens, contextWindow: model?.contextWindow ?? 200_000 } });
  }

  // One turn: the reply (everything said this run), or undefined when the message steered a run already going.
  async function reply(session: string, message: string): Promise<string | undefined> {
    const handle = await conversation(session);
    if (message.trim() === "/compact") {
      let said: string;
      try {
        await handle.compact(undefined, ctx);
        said = "Compacted: the conversation so far is summarized, freeing its context.";
      } catch (err) {
        said = `Nothing compacted: ${(err as Error).message}`;
      }
      event(session, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: said }] } });
      await status(session, handle);
      return said;
    }
    const text = `[${new Date().toString()}] ${message}`;
    const live = await harness.snapshot(LiveDoc, handle.id, ctx);
    if (live?.run !== undefined) {
      await handle.submit({ type: "input", content: text, whenBusy: "steer" }, ctx);
      return undefined;
    }
    const settled = await (await handle.submit({ type: "input", content: text }, ctx)).wait(ctx);
    await status(session, handle);
    if (settled.status !== "done") return `(That turn ended without an answer: ${(settled as { reason?: string }).reason ?? "unknown"}.)`;
    const context = await handle.context(ctx);
    const turn: string[] = [];
    for (const m of [...context.messages].reverse()) {
      if (m.role === "user") break;
      if (m.role !== "assistant") continue;
      const parts = typeof m.content === "string" ? [m.content] : (m.content as { type: string; text?: string }[]).flatMap((p) => (p.type === "text" && p.text ? [p.text] : []));
      if (parts.length) turn.unshift(parts.join("\n"));
    }
    return turn.join("\n\n");
  }

  const server = createServer(async (req, res) => {
    try {
      // A restarted gate may bring new tools and a new prompt: reinstalled in place; running work keeps its own.
      if (req.url === "/reload") return void res.end(void registry.install(await biscotti()));
      const { text, session = "main" } = JSON.parse(await readBody(req)) as { text?: string; session?: string };
      if (req.url === "/stop") return void res.end(void (await (await conversation(String(session))).abort(ctx)));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ reply: await reply(String(session), String(text)) }));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end(String(err));
    }
  });
  await listen(server, `${sockets}/agent.sock`);
  return { gateUrl };
}
