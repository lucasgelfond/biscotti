import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { listen, readBody } from "./http.ts";
import { searchableText } from "./memory.ts";

// The main agent: one long conversation, compacted by pi. It holds no keys and opens no database: model, tools, the
// system prompt and its transcript all come through the gate, and in production it runs in a container with no network,
// reaching the gate only through a socket.
export async function createAgent(opts: { dir: string; gateUrl: string; prompt: string; entries: FileEntry[]; save(entries: FileEntry[]): Promise<void> }) {
  const { dir, gateUrl } = opts;
  const models = { providers: { biscotti: { baseUrl: `${gateUrl}/llm`, api: "openai-completions", apiKey: "added-by-the-gate", models: [{ id: "main", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32768 }] } } };
  writeFileSync(`${dir}/models.json`, JSON.stringify(models));
  const modelRuntime = await ModelRuntime.create({ authPath: `${dir}/auth.json`, modelsPath: `${dir}/models.json`, modelsStorePath: `${dir}/models-store.json` });

  const mcp = createMcpExtension({
    loadConfig: () => ({
      servers: [{ name: "biscotti", source: "biscotti", scope: "extension", config: { url: `${gateUrl}/mcp`, exposure: "direct", timeout: 900 } }],
      errors: [],
    }),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: opts.prompt,
    noExtensions: true,
    extensionFactories: [mcp],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const saved = opts.entries;
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: modelRuntime.getModel("biscotti", "main"),
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(dir, undefined, saved.length ? saved : undefined),
    noTools: "builtin",
  });
  await session.bindExtensions({});

  // Only what's new since the last save goes to the gate.
  let savedCount = saved.length;
  async function save() {
    const manager = session.sessionManager;
    const entries: FileEntry[] = [manager.getHeader()!, ...manager.getEntries()];
    const fresh = entries.slice(savedCount);
    savedCount = entries.length;
    if (fresh.length) await opts.save(fresh);
  }

  return {
    // Undefined when the message steered a reply already underway.
    async reply(message: string): Promise<string | undefined> {
      const text = `[${new Date().toString()}] ${message}`;
      if (session.isStreaming) {
        await session.steer(text);
        return undefined;
      }
      const before = session.sessionManager.getEntries().length;
      try {
        await session.prompt(text);
      } finally {
        await save();
      }
      // Everything said this turn, including text written before a later tool call.
      return session.sessionManager
        .getEntries()
        .slice(before)
        .map((e) => (e.type === "message" ? searchableText(e) : null))
        .filter((t): t is string => !!t?.startsWith("assistant: "))
        .map((t) => t.slice("assistant: ".length))
        .join("\n\n");
    },
  };
}

// The agent's process: pi talks HTTP to a loopback port relayed to the gate's socket (the container has no network),
// and the gate hands it each turn on the agent's own socket.
export async function runAgent(sockets: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const relay = createTcpServer((client) => {
    const gate = connect(`${sockets}/gate.sock`);
    client.pipe(gate).pipe(client);
    gate.on("error", () => client.destroy());
    client.on("error", () => gate.destroy());
  });
  const port = await new Promise<number>((resolve) => relay.listen(0, "127.0.0.1", () => resolve((relay.address() as { port: number }).port)));
  const gateUrl = `http://127.0.0.1:${port}`;

  // The gate may still be starting.
  const get = async (path: string) => {
    for (;;) {
      const res = await fetch(`${gateUrl}${path}`).catch(() => undefined);
      if (res?.ok) return res;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const prompt = await (await get("/prompt")).text();
  const entries = (await (await get("/transcript")).json()) as FileEntry[];
  const agent = await createAgent({
    dir,
    gateUrl,
    prompt,
    entries,
    save: async (fresh) => void (await fetch(`${gateUrl}/transcript`, { method: "POST", body: JSON.stringify(fresh) })),
  });

  const server = createServer(async (req, res) => {
    try {
      const { text } = JSON.parse(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ reply: await agent.reply(text) }));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end(String(err));
    }
  });
  await listen(server, `${sockets}/agent.sock`);
  return { gateUrl, close: () => Promise.all([close(server), close(relay)]) };
}

const close = (server: { close(cb: () => void): unknown }) => new Promise<void>((resolve) => server.close(() => resolve()));
