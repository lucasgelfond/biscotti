import { readFileSync } from "node:fs";
import { connectAgent } from "./connect.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, scrub } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import { localTools, type Channel, type Context, type Plugin } from "./plugin.ts";
import { ownerApi } from "./http.ts";
import { emit } from "./plugin.ts";
import { gateTasks, localHost } from "./tasks.ts";
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
  // Task VMs, where the vms service runs (vms-main.ts); finished ones are kept, listed in the data directory.
  const vms = process.env.VMS_SOCKET
    ? await gateTasks(gate, localHost(process.env.VMS_SOCKET, env("VM_DIR")), (goal, { report, screenshot }, parent) => deliver(`Task report (${goal}):\n${report}`, screenshot, parent), `${dir}/tasks.json`)
    : undefined;
  const api = ownerApi();
  const send = async (text: string, image?: Buffer) => {
    if (image) await channel.send({ image });
    // Plugins' texts (a task's screenshot caption) can't pose as the gate's questions either.
    if (text) await channel.send(outbound(text.replace(LOCKS, "")));
  };
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, send, converse, vms: vms?.vms, route: api.route };
  const observers = await Promise.all(plugins.flatMap((p) => (p.observe ? [p.observe(ctx)] : [])));
  for (const observer of observers) gate.observe(observer);
  for (const plugin of plugins) if (plugin.llm) gate.serve(await plugin.llm(ctx));

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  gate.add(memoryTools(db, recalls));
  if (vms) gate.add(localTools(vms.tools));
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");

  // The main agent's sessions, as events for the owner's apps (numbered like tasks; "main", the owner's texts, is 0):
  // what the owner said, each tool call and message as it goes, and "replied" once a turn is done.
  const number = (session: string) => (session === "main" ? 0 : Number(session));
  const turn = await connectAgent(sockets, {
    db,
    prompt,
    gate: gate.handle,
    onEvent(session, e) {
      const id = number(session);
      if (e.type === "tool_execution_start" && e.toolName) emit({ id, type: "step", tool: e.toolName, text: JSON.stringify(e.args ?? {}).slice(0, 160) });
      const said = e.type === "message_end" && e.message?.role === "assistant" ? e.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n") : "";
      if (said) emit({ id, type: "step", text: outbound(said.replace(LOCKS, "")).text.slice(0, 4000) });
      // The model by the name its provider gives it (the agent knows it as "main").
      if (e.type === "status") emit({ id, type: "status", model: e.model === "main" ? env("MODEL") : e.model, thinking: e.thinking, used: e.context?.tokens ?? undefined, size: e.context?.contextWindow });
    },
  });

  // A message into a main session (the owner's, a wake, a task report): the agent's reply, which in "main" also goes
  // to the owner's texts. Other sessions answer only in the app they're in.
  async function deliver(text: string, image?: Buffer, session = "main") {
    const done = observers.map((o) => o.turn?.(outbound(text).text));
    try {
      const reply = (await turn(text, session))?.replace(LOCKS, "").trim();
      for (const end of done) end?.(reply && outbound(reply).text);
      emit({ id: number(session), type: "replied", ...(image && { screenshot: image }) });
      if (session !== "main") return;
      if (reply) await channel.send(outbound(reply));
      if (image) await channel.send({ image });
    } catch (err) {
      for (const end of done) end?.(undefined, err);
      emit({ id: number(session), type: "failed", text: (err as Error).message });
      console.error(err);
    }
  }
  // The owner in one of their apps (not their texts): the agent answers there, and texts only if asked to.
  async function converse(session: string, message: string) {
    emit({ id: number(session), type: "told", text: message });
    const command = message.trim().startsWith("/");
    await deliver(session === "main" || command ? message : `(In the owner's app: your reply shows there, not as a text.)\n${message}`, undefined, session);
  }

  async function handle(message: { text: string }) {
    if (gate.answer(message.text)) return;
    await converse("main", message.text);
  }

  for (const plugin of plugins) await plugin.start?.(ctx);
  await api.listen();
  return { db, channel, handle };
}
