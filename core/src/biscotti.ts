import { readFileSync } from "node:fs";
import { connectAgent } from "./connect.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, scrub } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import { input, localTools, str, text, type Channel, type Context, type LocalTool, type Plugin } from "./plugin.ts";
import { gateTasks } from "./tasks.ts";
import vault, { secrets } from "./vault.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Message = { text: string; react(emoji: string): Promise<unknown> };

// The gate: every key, the database, the channel and the plugins. `sockets` is the directory it shares with the main
// agent (agent-main.ts).
export async function start(opts: { plugins: Plugin[]; dir: string; sockets: string }) {
  const { dir, sockets } = opts;
  const plugins: Plugin[] = [crons, vault, ...opts.plugins];
  const db = openDb(`${dir}/biscotti.db`, env("DB_KEY"));
  // No text biscotti sends carries a saved secret, whoever wrote it: each becomes a placeholder.
  const outbound = (s: string) => ({ text: scrub(s, secrets(db)) as string });
  const gate = createGate({
    llm: { url: env("LLM_BASE_URL"), key: env("LLM_API_KEY") },
    models: { main: env("MODEL"), task: env("TASK_MODEL"), code: process.env.CODE_MODEL || env("TASK_MODEL") },
    send: (s) => channel.send(outbound(s)),
    secrets: () => secrets(db),
  });
  // Task VMs, where the vms service runs (vms-main.ts).
  const vms = process.env.VMS_SOCKET
    ? await gateTasks(gate, process.env.VMS_SOCKET, env("VM_DIR"), (goal, { report, screenshot }) => deliver(`Task report (${goal}):\n${report}`, screenshot))
    : undefined;
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, task: vms?.task };

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  let latest: Message | undefined;
  const react: LocalTool = {
    name: "react",
    description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
    input: input({ emoji: str() }),
    async run({ emoji }) {
      await latest?.react(String(emoji));
      return text("Reacted.");
    },
  };

  gate.add(memoryTools(db, recalls));
  gate.add(localTools([react, ...(vms ? [vms.tool] : [])]));
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");

  const turn = await connectAgent(sockets, { db, prompt, gate: gate.handle });

  // A link on its own line goes as its own message, so it expands into a preview.
  async function send(reply: string) {
    const lines = reply.replace(LOCKS, "").split("\n");
    const isLink = (line: string) => /^https?:\/\/\S+$/.test(line.trim());
    const body = lines.filter((l) => !isLink(l)).join("\n").trim();
    if (body) await channel.send(outbound(body));
    for (const link of lines.filter(isLink)) await channel.send(outbound(link.trim()));
  }

  async function deliver(text: string, image?: Buffer) {
    try {
      const reply = await turn(text);
      if (reply) await send(reply);
      if (image) await channel.send({ image });
    } catch (err) {
      console.error(err);
    }
  }

  async function handle(message: Message) {
    if (gate.answer(message.text)) return;
    latest = message;
    await deliver(message.text);
  }

  for (const plugin of plugins) await plugin.start?.(ctx);
  return { db, channel, handle };
}
