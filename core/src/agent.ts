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
import type { StateAction } from "@microsoft/agent-host-protocol";
import { WebSocketServer } from "ws";
import { AhpHost, ROOT } from "./ahp.ts";
import { agentTasks, type TaskRun } from "./agent-tasks.ts";
import { taskChats } from "./ahp-tasks.ts";
import { DurableChat } from "./ahp-durable.ts";
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

// Which conversation each session is, its title, when it was made, and where (an app's source and desktop shape for
// its tasks, as it said when it made it).
const Sessions = defineDoc<{ ids: Record<string, string>; titles?: Record<string, string>; created?: Record<string, string>; sources?: Record<string, string>; displays?: Record<string, string> }>({
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
  // One of the gate's methods for the apps (appMethod).
  const method = async (name: string, params: Record<string, unknown>) => {
    const res = await call("POST", `/x/${encodeURIComponent(name)}`, JSON.stringify(params), { "content-type": "application/json" });
    if (res.status >= 300) throw new Error(res.text || `${name} failed`);
    return JSON.parse(res.text) as unknown;
  };
  // A stream of JSON lines from the gate, followed again whenever it ends (the gate restarted).
  const stream = (path: string, onLine: (line: Record<string, unknown>) => void) => {
    const again = () => setTimeout(() => stream(path, onLine), 2000);
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      if (res.statusCode !== 200) return void (res.resume(), res.statusCode === 404 || again());
      let buffer = "";
      res.setEncoding("utf8").on("data", (d: string) => {
        buffer += d;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) onLine(JSON.parse(line));
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
    onConversation: (id, conversation) => void sandboxes.started(id, conversation),
  });

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
      conversations.clear();
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await open().then(() => true, () => false)) return;
      }
    });
  }
  await open();
  await tasks.settle();

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
          await harness.commit(async (tx) => {
            const doc = await tx.doc(Sessions);
            doc.ids[session] = id;
            doc.created = { ...doc.created, [session]: new Date().toISOString() };
          }, ctx);
          // A new session, for the apps' catalogues.
          void catalogue().then((all) => host.notify(ROOT, "root/sessionAdded", { summary: all.find((s) => s.resource === `ahp-session:/${session}`) }));
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

  // The Agent Host Protocol: each session an AHP session whose default chat is its conversation, opened when a client
  // first looks at it.
  const SESSION = "ahp-session:/";
  const CHAT = "ahp-chat:/";
  const sessionOf_ = (uri: string) => (uri.startsWith(SESSION) ? uri.slice(SESSION.length) : uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[0] : undefined);
  const chats = new Map<string, DurableChat>();
  const sessions = async () => (await harness.snapshot(Sessions, ctx)) ?? { ids: {}, titles: {} };
  const titleOf = (session: string, titles?: Record<string, string>) => titles?.[session] ?? (session === "main" ? "Texts" : "New session");
  // Its source as the app gave it (JSON).
  const sourceOf = (doc: { sources?: Record<string, string> } | undefined, session: string) => (doc?.sources?.[session] ? (JSON.parse(doc.sources[session]) as unknown) : undefined);
  const meta = (session: string, doc?: { sources?: Record<string, string>; displays?: Record<string, string> }) => ({
    biscotti: {
      kind: "main",
      model: names.main,
      size: CONTEXT_WINDOW,
      source: session === "main" ? "imessage" : sourceOf(doc, session),
      ...(doc?.displays?.[session] && { display: doc.displays[session] }),
      chats: sandboxes.of(session),
    },
  });
  let summaries: Record<string, unknown>[] = [];
  async function catalogue() {
    const doc = await sessions();
    const { ids, titles, created } = doc;
    summaries = Object.keys(ids).map((session) => {
      const chat = host.get<{ status: number; modifiedAt: string }>(`${CHAT}${session}`);
      const made = created?.[session] ?? new Date(0).toISOString();
      return { resource: `${SESSION}${session}`, provider: "biscotti", title: titleOf(session, titles), status: chat?.status ?? 1, createdAt: made, modifiedAt: chat?.modifiedAt ?? made, defaultChat: `${CHAT}${session}`, _meta: meta(session, doc) };
    });
    // Newest first.
    summaries.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    return summaries;
  }
  async function openSession(session: string) {
    const uri = `${SESSION}${session}`;
    if (host.has(uri)) return;
    const handle = await conversation(session);
    const doc = await sessions();
    const title = titleOf(session, doc.titles);
    host.create(uri, { provider: "biscotti", title, status: 1, lifecycle: "ready", activeClients: [], chats: [], _meta: meta(session, doc) });
    const chatUri = `${CHAT}${session}`;
    const chat = new DurableChat({ host, harness, conversation: handle, uri: chatUri, ctx, onStatus, named: (id) => names[id] ?? id });
    function onStatus(status: number) {
      host.dispatch(uri, { type: "session/chatUpdated", chat: chatUri, changes: { status, modifiedAt: new Date().toISOString() } } as unknown as StateAction);
      void catalogue().then(() => host.notify(ROOT, "root/sessionSummaryChanged", { session: uri, changes: { status, modifiedAt: new Date().toISOString() } }));
    }
    await chat.open(title);
    chats.set(chatUri, chat);
    host.dispatch(uri, { type: "session/chatAdded", summary: { resource: chatUri, title, status: 1, modifiedAt: new Date().toISOString(), origin: { kind: "user" } } } as unknown as StateAction);
    host.dispatch(uri, { type: "session/defaultChatChanged", defaultChat: chatUri } as unknown as StateAction);
    // Its sandboxes and VMs.
    for (const summary of sandboxes.summaries(session)) host.dispatch(uri, { type: "session/chatAdded", summary } as unknown as StateAction);
  }
  // The board's sandboxes and VMs, as chats of their sessions (ahp-tasks.ts).
  const sandboxes = taskChats({
    host: { get: (u: string) => host.get(u), has: (u: string) => host.has(u), create: (u: string, s: object) => host.create(u, s), delete: (u: string) => host.delete(u), dispatch: (c: string, a: StateAction) => host.dispatch(c, a) } as unknown as AhpHost,
    harness: () => harness,
    ctx,
    method,
    follow: stream,
    conversation: (id) => tasks.conversation(id),
    named: (id) => names[id] ?? id,
    changed(session) {
      const uri = `${SESSION}${session}`;
      void sessions().then(async (doc) => {
        if (!(session in doc.ids)) return;
        const _meta = meta(session, doc);
        if (host.has(uri)) host.dispatch(uri, { type: "session/metaChanged", _meta } as unknown as StateAction);
        await catalogue();
        host.notify(ROOT, "root/sessionSummaryChanged", { session: uri, changes: { _meta } });
      });
    },
  });
  const host: AhpHost = new AhpHost(
    {
      listSessions: () => catalogue(),
      async hydrate(uri) {
        if (sandboxes.owns(uri)) return sandboxes.hydrate(uri);
        const session = sessionOf_(uri);
        if (!session || !(session in (await sessions()).ids)) return false;
        await openSession(session);
        return host.has(uri);
      },
      async createSession(params) {
        const session = sessionOf_(String(params.channel));
        if (!session) throw new Error("a session's channel is ahp-session:/<id>");
        // Where it was made, as the app says (its source, and the desktop shape for its tasks).
        const asked = ((params._meta as { biscotti?: { source?: unknown; display?: unknown } } | undefined)?.biscotti ?? {}) as { source?: unknown; display?: unknown };
        if (asked.source !== undefined || typeof asked.display === "string")
          await harness.commit(async (tx) => {
            const doc = await tx.doc(Sessions);
            if (asked.source !== undefined) doc.sources = { ...doc.sources, [session]: JSON.stringify(asked.source) };
            if (asked.display === "mobile" || asked.display === "desktop") doc.displays = { ...doc.displays, [session]: asked.display };
          }, ctx);
        await conversation(session);
        await openSession(session);
        await catalogue();
        host.notify(ROOT, "root/sessionAdded", { summary: summaries.find((s) => s.resource === params.channel) });
      },
      async disposeSession(uri) {
        const session = sessionOf_(uri);
        if (!session || !(session in (await sessions()).ids)) throw new Error(`no session ${uri}`);
        await (await conversation(session)).abort(ctx).catch(() => {});
        await harness.commit(async (tx) => {
          const doc = await tx.doc(Sessions);
          delete doc.ids[session];
          if (doc.titles) delete doc.titles[session];
        }, ctx);
        conversations.delete(session);
        chats.delete(`${CHAT}${session}`);
        host.delete(`${CHAT}${session}`);
        host.delete(uri);
        await catalogue();
        host.notify(ROOT, "root/sessionRemoved", { session: uri });
      },
      async disposeChat(uri) {
        if (!sandboxes.owns(uri)) throw new Error("only a session's sandboxes and VMs can go; its own chat goes with it (disposeSession)");
        await sandboxes.dispose(uri);
      },
      methods: Object.fromEntries(Object.entries(sandboxes.methods).map(([name, run]) => [name, (params: Record<string, unknown>) => run(params)])),
      validate(channel, action) {
        if (sandboxes.owns(channel)) return sandboxes.validate(channel, action);
        const chat = chats.get(channel);
        if ((action.type as string) === "chat/turnStarted" && chat?.running) return "a turn is running: steer it with a pending message, or cancel it first";
        return undefined;
      },
      acted(channel, action) {
        if (sandboxes.owns(channel)) return sandboxes.acted(channel, action);
        const chat = chats.get(channel);
        if (!chat) return;
        const a = action as unknown as { type: string; turnId: string; message?: { text: string } };
        if (a.type === "chat/turnStarted") {
          const session = sessionOf_(channel)!;
          void sessions().then(async ({ titles }) => {
            if (titles?.[session] || session === "main") return;
            const title = a.message!.text.split("\n")[0].slice(0, 80);
            await harness.commit(async (tx) => void ((await tx.doc(Sessions)).titles = { ...((await tx.doc(Sessions)).titles ?? {}), [session]: title }), ctx);
            host.dispatch(`${SESSION}${session}`, { type: "session/titleChanged", title } as unknown as StateAction);
            host.dispatch(`${SESSION}${session}`, { type: "session/chatUpdated", chat: channel, changes: { title } } as unknown as StateAction);
            await catalogue();
            host.notify(ROOT, "root/sessionSummaryChanged", { session: `${SESSION}${session}`, changes: { title } });
          });
          void chat.started(a.turnId, a.message?.text ?? "").catch((err) => console.error(`a turn from an app: ${(err as Error).message}`));
        }
        if (a.type === "chat/turnCancelled") void chat.cancel();
      },
    },
    { name: "biscotti", version: process.env.BISCOTTI_VERSION ?? "dev" },
  );
  host.create(ROOT, { agents: [{ provider: "biscotti", displayName: "biscotti", description: "biscotti's main agent", models: [] }] });
  await catalogue();

  const server = createServer(async (req, res) => {
    try {
      // A restarted gate may bring new tools and a new prompt: reinstalled in place; running work keeps its own.
      if (req.url === "/reload") return void (tasks.reload(), res.end(void registry.install(await biscotti())));
      // A task's run, for the gate: what it does, as lines, until it's done.
      if (req.url === "/task") return void (await tasks.run(JSON.parse(await readBody(req)) as TaskRun, res, registry));
      const { text, session = "main" } = JSON.parse(await readBody(req)) as { text?: string; session?: string };
      if (req.url === "/stop") return void res.end(void (await (await conversation(String(session))).abort(ctx)));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ reply: await reply(String(session), String(text)) }));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end(String(err));
    }
  });
  const sockets_ = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://agent").pathname !== "/ahp") return void socket.destroy();
    sockets_.handleUpgrade(req, socket, head, (ws) => host.accept(ws));
  });
  await listen(server, `${sockets}/agent.sock`);
  return { gateUrl };
}
