import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "./agent.ts";
import crons from "./crons.ts";
import { createGate } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import type { Channel, Context, Plugin } from "./plugin.ts";
import { SLOTS, taskTool, taskVms } from "./tasks.ts";
import vault, { secrets } from "./vault.ts";


function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Message = { text: string; react(emoji: string): Promise<unknown> };

export async function start(opts: { plugins: Plugin[]; dir: string; gatePort?: number }) {
  const { dir } = opts;
  const plugins: Plugin[] = [crons, vault, ...opts.plugins];
  const db = openDb(`${dir}/biscotti.db`, env("DB_KEY"));
  const gate = createGate({
    llm: { url: env("LLM_BASE_URL"), key: env("LLM_API_KEY") },
    models: { main: env("MODEL"), task: env("TASK_MODEL") },
    send: (text) => channel.send({ text }),
    secrets: () => secrets(db),
  });
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver };

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  const gateServer = await gate.listen("127.0.0.1", opts.gatePort ?? 0);
  const gateUrl = `http://127.0.0.1:${(gateServer.address() as AddressInfo).port}`;
  const vmDir = process.env.VM_DIR;
  if (vmDir) for (const slot of SLOTS) await gate.listen(`10.200.${slot}.1`, 80, { slot });

  let latest: Message | undefined;
  const react = defineTool({
    name: "react",
    label: "Tapback",
    description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
    parameters: Type.Object({ emoji: Type.String() }),
    async execute(_id, { emoji }) {
      await latest?.react(emoji);
      return { content: [{ type: "text" as const, text: "Reacted." }], details: {} };
    },
  });

  const liveDesktop = process.env.LIVE_DESKTOP_URL ?? (process.env.TAILNET_HOST && `https://${process.env.TAILNET_HOST}`);
  const tasks = vmDir
    ? [
        taskTool(
          taskVms(vmDir, env("FIRECRACKER")),
          (goal, { report, screenshot }) => deliver(`Task report (${goal}):\n${report}`, screenshot),
          liveDesktop ? (slot) => `${liveDesktop}:${10440 + slot}/vnc.html` : undefined,
        ),
      ]
    : [];
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");
  const agent = await createAgent({ db, dir, gateUrl, prompt, tools: [...memoryTools(db, recalls), react, ...tasks] });

  // A link on its own line goes as its own message, so it expands into a preview.
  async function send(reply: string) {
    const lines = reply.split("\n");
    const isLink = (line: string) => /^https?:\/\/\S+$/.test(line.trim());
    const body = lines.filter((l) => !isLink(l)).join("\n").trim();
    if (body) await channel.send({ text: body });
    for (const link of lines.filter(isLink)) await channel.send({ text: link.trim() });
  }

  async function deliver(text: string, image?: Buffer) {
    try {
      const reply = await agent.reply(text);
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
  return { db, gateUrl, channel, handle };
}
