import { readFileSync } from "node:fs";
import { connectAgent } from "./connect.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, scrub } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import { localTools, type Channel, type Context, type Plugin } from "./plugin.ts";
import { startApi } from "./api.ts";
import { taskBoard } from "./board.ts";
import { pusher } from "./push.ts";
import { gateTasks, taskEvents, type TaskEvent } from "./tasks.ts";
import vault, { secrets } from "./vault.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// The gate: every key, the database, the channel and the plugins. `sockets` is the directory it shares with the main
// agent (agent-main.ts).
export async function start(opts: { plugins: Plugin[]; dir: string; sockets: string }) {
  const { dir, sockets } = opts;
  const plugins: Plugin[] = [crons, vault, ...opts.plugins];
  const db = openDb(`${dir}/biscotti.db`, env("DB_KEY"));
  // No text biscotti sends carries a saved secret, whoever wrote it: each becomes a placeholder.
  const outbound = (s: string) => ({ text: scrub(s, secrets(db)) as string });
  const gate = createGate({
    llm: { url: env("LLM_BASE_URL"), key: env("LLM_API_KEY"), extra: process.env.LLM_EXTRA ? JSON.parse(process.env.LLM_EXTRA) : undefined },
    models: { main: env("MODEL"), task: env("TASK_MODEL"), code: process.env.CODE_MODEL || env("TASK_MODEL") },
    send: (s) => channel.send(outbound(s)),
    secrets: () => secrets(db),
  });
  // Task VMs, where the vms service runs (vms-main.ts).
  const vms = process.env.VMS_SOCKET
    ? await gateTasks(gate, process.env.VMS_SOCKET, env("VM_DIR"), (goal, { report, screenshot }) => deliver(`Task report (${goal}):\n${report}`, screenshot))
    : undefined;
  const send = async (text: string, image?: Buffer) => {
    if (image) await channel.send({ image });
    // Plugins' texts (a task's screenshot caption) can't pose as the gate's questions either.
    if (text) await channel.send(outbound(text.replace(LOCKS, "")));
  };
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, send, task: vms?.task };
  const observers = await Promise.all(plugins.flatMap((p) => (p.observe ? [p.observe(ctx)] : [])));
  for (const observer of observers) gate.observe(observer);

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  gate.add(memoryTools(db, recalls));
  if (vms) gate.add(localTools(vms.tools));
  // The task API for the app and the multiplexer, and push notifications when a task reports (api.ts, push.ts).
  if (vms && process.env.API_PORT !== "0") {
    const push = pusher(dir);
    const board = taskBoard(vms.kept);
    taskEvents.on("event", (e: TaskEvent) => {
      if (e.type === "report") void push.notify(`Task #${e.id} reported`, e.text ?? "", e.id);
      if (e.type === "failed") void push.notify(`Task #${e.id} failed`, e.text ?? "", e.id);
    });
    await startApi(board, vms.actions, push);
  }
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");

  const turn = await connectAgent(sockets, { db, prompt, gate: gate.handle });

  async function deliver(text: string, image?: Buffer) {
    const done = observers.map((o) => o.turn?.(outbound(text).text));
    try {
      const reply = (await turn(text))?.replace(LOCKS, "").trim();
      for (const end of done) end?.(reply && outbound(reply).text);
      if (reply) await channel.send(outbound(reply));
      if (image) await channel.send({ image });
    } catch (err) {
      for (const end of done) end?.(undefined, err);
      console.error(err);
    }
  }

  async function handle(message: { text: string }) {
    if (gate.answer(message.text)) return;
    await deliver(message.text);
  }

  for (const plugin of plugins) await plugin.start?.(ctx);
  return { db, channel, handle };
}
