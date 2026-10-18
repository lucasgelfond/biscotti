import { readFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { transcripts, type Db } from "./db.ts";
import { searchableText } from "./memory.ts";

const systemPrompt = readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8");

export interface AgentOptions {
  db: Db;
  dir: string;
  model?: string;
  tools: ToolDefinition[];
  extensions?: ExtensionFactory[];
}

// One continuous conversation, rebuilt from the transcripts table and compacted by pi as it grows.
export async function createAgent({
  db,
  dir,
  model = "vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast",
  tools,
  extensions = [],
}: AgentOptions) {
  const [provider, ...rest] = model.split("/");
  // models.json adds gateway models pi's catalog doesn't list yet.
  const modelsPath = new URL("../models.json", import.meta.url).pathname;
  const modelRuntime = await ModelRuntime.create({ authPath: `${dir}/auth.json`, modelsPath });
  const resolved = modelRuntime.getModel(provider, rest.join("/"));
  if (!resolved) throw new Error(`unknown model ${model}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt,
    noExtensions: true,
    extensionFactories: extensions,
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
    model: resolved,
    modelRuntime,
    resourceLoader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(dir, undefined, saved.length ? saved.map((r) => r.entry) : undefined),
    noTools: "builtin",
    customTools: tools,
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
