import { writeFileSync } from "node:fs";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { searchableText, type Db } from "./memory.ts";
import { transcripts } from "./schema.ts";

// One continuous conversation, rebuilt from the transcripts table and compacted by pi as it grows. The model and
// every plugin's tools come through the gate, so the agent holds no keys.
export async function createAgent(opts: { db: Db; dir: string; gateUrl: string; prompt: string; tools: ToolDefinition[] }) {
  const { db, dir, gateUrl } = opts;
  // The gate maps the model name "main" to the real model.
  const models = { providers: { biscotti: { baseUrl: `${gateUrl}/llm`, api: "anthropic-messages", apiKey: "added-by-the-gate", models: [{ id: "main", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32768 }] } } };
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

  const saved = db.select({ entry: transcripts.entry }).from(transcripts).orderBy(transcripts.seq).all();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: modelRuntime.getModel("biscotti", "main"),
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(dir, undefined, saved.length ? saved.map((r) => r.entry) : undefined),
    noTools: "builtin",
    customTools: opts.tools,
  });
  await session.bindExtensions({});

  function save() {
    const manager = session.sessionManager;
    const entries: FileEntry[] = [manager.getHeader()!, ...manager.getEntries()];
    db.insert(transcripts)
      .values(entries.map((entry) => ({ id: entry.id, entry, text: searchableText(entry) })))
      .onConflictDoNothing()
      .run();
  }

  return {
    // Resolves with the reply, or undefined when the text was folded into a reply already underway.
    async reply(message: string): Promise<string | undefined> {
      const text = `[${new Date().toString()}] ${message}`;
      if (session.isStreaming) {
        await session.steer(text);
        return undefined;
      }
      try {
        await session.prompt(text);
      } finally {
        save();
      }
      return session.getLastAssistantText();
    },
  };
}
