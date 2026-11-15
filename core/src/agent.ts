import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  type Conversation,
  type ConversationId,
  type Extension,
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
import { durableAhp, inputFrom } from "pi-durable-acp-ahp";
import { agentTasks, type TaskRun } from "./agent-tasks.ts";
import { sandboxes } from "./sandboxes.ts";
import { listen, readBody } from "./http.ts";
import { RemoteSqliteDatabase, type SqlRequest } from "./sql-bridge.ts";

// The main agent: pi-durable runs every conversation, each turn and tool call committed before it shows, so a run a
// crash or restart cut off picks up where it was. It holds no keys and has no network: its storage (the gate's
// encrypted database), its model, biscotti's tools and the system prompt all come through the gate's socket, and the
// gate hands it each turn on the agent's own socket. Sessions: "main" (the owner's texts) and the others by number or
// by the id an app gave them. The owner's apps see and drive them over the Agent Host Protocol (/ahp on its socket).
// Tasks are conversations too (agent-tasks.ts), their tools in the task's VM.

const ctx = BACKGROUND_CONTEXT;
const MAIN_MODEL = { provider: "biscotti", modelId: "main" } as const;
const CONTEXT_WINDOW = 200_000;

// The sessions' catalogue as biscotti kept it before pi-durable-acp-ahp did (until 2026-11-15), for adopting them.
const BeforeSessions = defineDoc<{ ids: Record<string, string>; titles?: Record<string, string>; created?: Record<string, string>; sources?: Record<string, string>; displays?: Record<string, string> }>({
  kind: "biscotti.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {}, titles: {} }),
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

  // The gate, with no time limit (a tool call may wait minutes on the owner's yes). Each request on a connection of its
  // own: one kept alive between requests can be closed by the gate just as the next is sent (Node's server lets an
  // idle connection go after 5 s), and that request is lost, e.g. a commit of the agent's storage.
  const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
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
  // One of the gate's methods for the apps (appMethod).
  const method = async (name: string, params: Record<string, unknown>) => {
    const res = await call("POST", `/x/${encodeURIComponent(name)}`, JSON.stringify(params), { "content-type": "application/json" });
    if (res.status >= 300) throw new Error(res.text || `${name} failed`);
    return JSON.parse(res.text) as unknown;
  };
  // A stream of JSON lines from the gate, followed again whenever it ends (the gate restarted).
  const stream = (path: string, onLine: (line: Record<string, unknown>) => void) => {
    const again = () => setTimeout(() => stream(path, onLine), 2000);
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      if (res.statusCode !== 200) return void (res.resume(), res.statusCode === 404 || again());
      let buffer = "";
      res.setEncoding("utf8").on("data", (d: string) => {
        buffer += d;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          try {
            if (line.trim()) onLine(JSON.parse(line));
          } catch (err) {
            console.error(`${path}: ${(err as Error).message}`);
          }
        }
      });
      res.on("end", again).on("error", () => {});
    });
    req.on("error", again);
    req.end();
  };

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
  let installed: Extension | undefined;
  async function biscotti() {
    const prompt = await get("/prompt");
    const { tools } = (await mcp("main", "tools/list", {})) as { tools: { name: string; description?: string; inputSchema: object; _meta?: Record<string, unknown> }[] };
    return (installed = defineExtension({
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
    }));
  }

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "biscotti",
      baseUrl: `${gateUrl}/llm`,
      auth: { apiKey: { name: "the gate", resolve: async () => ({ auth: { apiKey: "added-by-the-gate" } }) } },
      // The gate's names for its models: the main agent's, tasks' and coding tasks'.
      models: ["main", "task", "code"].map((id) => ({
        id,
        name: id,
        api: "openai-completions" as const,
        provider: "biscotti",
        baseUrl: `${gateUrl}/llm`,
        reasoning: true,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 32_768,
        // A plain OpenAI-compatible endpoint (the gate, in front of DeepSeek and others): a system role, no store.
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" as const },
      })),
      api: openAICompletionsApi(),
    }),
  );
  // The models' names for the owner's apps: the provider's ids for main, task and code.
  const names = JSON.parse(await get("/models")) as Record<string, string>;
  const registry = createRegistry();
  registry.install(await biscotti());
  const toolSearch = createToolSearchExtension();
  registry.install(toolSearch);
  // pi-env's daemon in a task's VM, through the gate (env-pipe.ts).
  const tasks = agentTasks({
    harness: () => harness,
    ctx,
    call,
    daemon: (id) => [process.execPath, new URL("./env-pipe.ts", import.meta.url).pathname, sockets, String(id)],
    onConversation: (id, conversation) => board.started(id, conversation.id),
  });

  const database = new RemoteSqliteDatabase(async (req: SqlRequest) => {
    const res = await call("POST", "/sql", JSON.stringify(req), { "content-type": "application/json" });
    if (res.status >= 300) throw new Error(`the gate's database: ${res.text}`);
    return (JSON.parse(res.text) as { answer?: unknown }).answer;
  });

  // Open (and reopen, after the gate restarts mid-commit) over the gate's database; resume what was running.
  let harness!: Harness;
  async function open() {
    harness = await Harness.open(
      await SqliteStorage.open(database, { prefix: "pi_" }),
      {
        models,
        registry,
        // The main agent's sessions have biscotti's tools; tasks choose their own (agent-tasks.ts).
        settings: () => ({ compaction: { reserveTokens: 16_384 }, extensions: [installed!, toolSearch] }),
        env: ({ conversationId, read }, c) => tasks.env(conversationId, read as never, c),
        onReport: (report) => console.error(`pi-durable: ${report.kind}${report.error ? `: ${String(report.error)}` : ""}`),
      },
      ctx,
    );
    harness.resume();
    void harness.closed.then(async (end) => {
      if (end.kind !== "failed") return;
      ahp.reset();
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await open().then(() => true, () => false)) return;
      }
    });
  }
  await open();
  await tasks.settle();

  // What each session says, as it's committed, for memory (the gate's searchable transcript).
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
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as { type: string; text?: string }[]);
        const said = parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n").trim();
        rows.push({ id: entry.id, entry, text: said && (message.role === "user" || message.role === "assistant") ? `${message.role}: ${said}` : null });
      }
      if (rows.length) await call("POST", `/transcript?session=${encodeURIComponent(session)}`, JSON.stringify(rows)).catch(() => {});
    };
    for (const entry of watch.value.entries) seen.add(String(entry.id));
    watch.start(async (c) => {
      if (c.kind === "value") await take(c.value.entries as never);
    });
  }

  // One turn: the reply (everything said this run), or undefined when the message steered a run already going.
  // `origin`: who it's from (AHP's message kinds), the owner's ("user") or biscotti's own (a task report, a wake).
  async function reply(session: string, message: string, origin = "user"): Promise<string | undefined> {
    const handle = await conversation(session);
    if (message.trim() === "/compact") {
      let said: string;
      try {
        await handle.compact(undefined, ctx);
        said = "Compacted: the conversation so far is summarized, freeing its context.";
      } catch (err) {
        said = `Nothing compacted: ${(err as Error).message}`;
      }
      return said;
    }
    const text = `[${new Date().toString()}] ${message}`;
    const entry = inputFrom(origin);
    const live = await harness.snapshot(LiveDoc, handle.id, ctx);
    if (live?.run !== undefined) {
      await handle.submit({ type: "input", content: text, whenBusy: "steer", ...entry }, ctx);
      return undefined;
    }
    const settled = await (await handle.submit({ type: "input", content: text, ...entry }, ctx)).wait(ctx);
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

  // The owner's apps see and drive the sessions over the Agent Host Protocol (/ahp) or the Agent Client Protocol (/acp,
  // pi-durable-acp-ahp): "main" is the owner's texts (the root conversation), the others an app's; a session's tasks and
  // VMs are chats beside it (sandboxes.ts).
  const board = sandboxes({
    method,
    follow: stream,
    conversation: (id) => tasks.conversation(id).then((c) => c?.id),
    changed: (session) => ahp.changed(session),
  });
  const ahp = durableAhp({
    harness: () => harness,
    context: ctx,
    info: { name: "biscotti", version: process.env.BISCOTTI_VERSION ?? "dev" },
    agent: { provider: "biscotti", displayName: "biscotti", description: "biscotti's main agent" },
    create: (session) =>
      session === "main" ? harness.root(ctx, { agent: { model: MAIN_MODEL } }) : harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MAIN_MODEL } }, ctx),
    opened(session, handle) {
      sessionOf.set(String(handle.id), session);
      void follow(session, handle).catch((err) => console.error(`following ${session}: ${(err as Error).message}`));
    },
    title: (session) => (session === "main" ? "Texts" : undefined),
    meta: (session) => ({ biscotti: { kind: "main", model: names.main, size: CONTEXT_WINDOW, ...(session === "main" && { source: "imessage" }), chats: board.records(session) } }),
    chats: (session) => board.chats(session),
    send: (_session, key, text) => board.send(key, text),
    cancel: (_session, key) => board.cancel(key),
    dispose: (_session, key) => board.dispose(key),
    named: (id) => names[id] ?? id,
    // Inputs carry the time they were sent, for the model; the chat shows what was said.
    input: (text) => `[${new Date().toString()}] ${text}`,
    said: (text) => text.replace(/^\[[^\]]*\] /, ""),
    // Each also by its ACP name's (_biscotti/vms/open is x-biscotti/vms/open; the app's is x-biscotti/vms.open).
    methods: Object.fromEntries(
      Object.entries(board.methods).flatMap(([name, run]) => [name, name.replace(/\.(?=[^/]*$)/, "/")].map((n) => [n, (params: Record<string, unknown>) => run(params)])),
    ),
  });
  const conversation = (session: string) => ahp.conversation(session);
  // Sessions from before pi-durable-acp-ahp kept the catalogue, adopted into it (once: a known one is left as it is).
  // TODO: remove once every install has started since.
  const before = await harness.snapshot(BeforeSessions, ctx);
  for (const [session, id] of Object.entries(before?.ids ?? {})) {
    const source = before?.sources?.[session] ? (JSON.parse(before.sources[session]) as unknown) : undefined;
    const display = before?.displays?.[session];
    const biscotti = { ...(source !== undefined && { source }), ...(display && { display }) };
    await ahp.adopt(session, Number(id) as unknown as ConversationId, { title: before?.titles?.[session], created: before?.created?.[session], ...(Object.keys(biscotti).length && { meta: { biscotti } }) });
  }
  // The owner's texts are a session from the start, not only once something's said in them.
  await conversation("main");
  const acp = ahp.acp({ contextWindow: CONTEXT_WINDOW });
  const path = (url = "/") => new URL(url, "http://agent").pathname;

  const server = createServer(async (req, res) => {
    try {
      // A restarted gate may bring new tools and a new prompt: reinstalled in place; running work keeps its own.
      if (req.url === "/reload") return void (tasks.reload(), res.end(void registry.install(await biscotti())));
      // A task's run, for the gate: what it does, as lines, until it's done.
      if (req.url === "/task") return void (await tasks.run(JSON.parse(await readBody(req)) as TaskRun, res, registry));
      // ACP's Streamable HTTP.
      if (path(req.url) === "/acp") return void acp.http(req, res);
      const { text, session = "main", origin } = JSON.parse(await readBody(req)) as { text?: string; session?: string; origin?: string };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ reply: await reply(String(session), String(text), origin) }));
    } catch (err) {
      console.error(err);
      // A task's run has its lines started already.
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (path(req.url) === "/ahp") return ahp.upgrade(req, socket, head);
    if (path(req.url) === "/acp") return acp.upgrade(req, socket, head);
    socket.destroy();
  });
  await listen(server, `${sockets}/agent.sock`);
  return { gateUrl };
}
