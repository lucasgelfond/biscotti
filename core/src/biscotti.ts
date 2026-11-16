import { readFileSync } from "node:fs";
import { connectAgent } from "./connect.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, scrub } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import type { Channel, Context, Plugin } from "./plugin.ts";
import { ownerApi } from "./http.ts";
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
  const models = { main: env("MODEL"), task: env("TASK_MODEL"), code: process.env.CODE_MODEL || env("TASK_MODEL") };
  const gate = createGate({
    llm: { url: env("LLM_BASE_URL"), key: env("LLM_API_KEY"), extra: process.env.LLM_EXTRA ? JSON.parse(process.env.LLM_EXTRA) : undefined },
    models,
    send: (s) => channel.send(outbound(s)),
    secrets: () => secrets(db),
  });
  const prompt = [readFileSync(new URL("../../prompts/SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");
  const agent = await connectAgent(sockets, { db, prompt, models, plugins: plugins.flatMap((p) => (p.agent ? [p.agent] : [])), gate: gate.handle });
  const api = ownerApi();
  // The owner's apps reach the agent itself over the Agent Host Protocol.
  api.upgrade("/ahp", `${sockets}/agent.sock`);
  const send = async (text: string, image?: Buffer) => {
    if (image) await channel.send({ image });
    // Plugins' texts (a task's screenshot caption) can't pose as the gate's questions either.
    if (text) await channel.send(outbound(text.replace(LOCKS, "")));
  };
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, send, route: api.route, gate, agent: agent.agent };
  const observers = await Promise.all(plugins.flatMap((p) => (p.observe ? [p.observe(ctx)] : [])));
  for (const observer of observers) gate.observe(observer);
  for (const plugin of plugins) if (plugin.llm) gate.serve(await plugin.llm(ctx));

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));
  gate.add(memoryTools(db, recalls));

  // A message into a main session (a wake, a task report; or the owner's, `fromOwner`): the agent's reply, which in
  // "main" also goes to the owner's texts. Other sessions answer only in the app they're in.
  async function deliver(text: string, image?: Buffer, session = "main", fromOwner = false) {
    const done = observers.map((o) => o.turn?.(outbound(text).text));
    try {
      const reply = (await agent.turn(text, session, fromOwner ? "user" : "systemNotification"))?.replace(LOCKS, "").trim();
      for (const end of done) end?.(reply && outbound(reply).text);
      if (session !== "main") return;
      if (reply) await channel.send(outbound(reply));
      if (image) await channel.send({ image });
    } catch (err) {
      for (const end of done) end?.(undefined, err);
      console.error(err);
    }
  }
  // The owner's text: the agent's reply goes back as one.
  async function handle(message: { text: string }) {
    if (gate.answer(message.text)) return;
    await deliver(message.text, undefined, "main", true);
  }

  for (const plugin of plugins) await plugin.start?.(ctx);
  await agent.open();
  await api.listen();
  return { db, channel, handle, ctx, close: agent.close };
}
