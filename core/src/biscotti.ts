import { readFileSync } from "node:fs";
import { connectAgent } from "./connect.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, scrub } from "./gate.ts";
import { memoryTools, openDb } from "./memory.ts";
import { appMethod, localTools, type Channel, type Context, type Host, type Plugin } from "./plugin.ts";
import { ownerApi, passTo } from "./http.ts";
import { sqlBridge } from "./sql-bridge.ts";
import { gateTasks } from "./tasks.ts";
import { vmEnv } from "./vm-env.ts";
import { board } from "./board.ts";
import vault, { secrets } from "./vault.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// The gate: every key, the database, the channel and the plugins. `sockets` is the directory it shares with the main
// agent (agent-main.ts).
// `vms`: a machine for task VMs of the caller's (a test's); plugins add the others (firecracker, external-vm-node).
export async function start(opts: { plugins: Plugin[]; dir: string; sockets: string; vms?: Host }) {
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
  // Task VMs, on the machines plugins add; finished ones are kept, listed in the data directory. The main agent runs
  // each one (agent-tasks.ts), its tools in the VM through pi-env, which the gate runs there over ssh with a key of its
  // own (vm-env.ts).
  const pipes = vmEnv(dir);
  const vms = await gateTasks(gate, opts.vms, (goal, { report, screenshot }, parent) => deliver(`Task report (${goal}):\n${report}`, screenshot, parent), `${dir}/tasks.json`, (text) => deliver(text), {
    key: pipes.publicKey,
    trust: pipes.trust,
    pipe: pipes.pipe,
    run: (task, stopped) => turn.task(task, stopped),
  });
  const api = ownerApi();
  // The owner's apps reach the agent itself over the Agent Host Protocol, or the Agent Client Protocol (a WebSocket, or
  // Streamable HTTP).
  api.upgrade("/ahp", `${sockets}/agent.sock`);
  api.upgrade("/acp", `${sockets}/agent.sock`);
  api.route("/acp", passTo(`${sockets}/agent.sock`));
  const send = async (text: string, image?: Buffer) => {
    if (image) await channel.send({ image });
    // Plugins' texts (a task's screenshot caption) can't pose as the gate's questions either.
    if (text) await channel.send(outbound(text.replace(LOCKS, "")));
  };
  const tasks = board(db, vms.vms);
  // The apps' own methods for tasks and VMs (the board's sandboxes and VMs): its live desktop (which keeps it open), a
  // message for it, stopping it, deleting it.
  {
    const pool = vms.vms;
    const id = (p: Record<string, unknown>) => {
      const n = Number(p.id);
      if (!Number.isInteger(n) || n <= 0) throw new Error("which task or VM? (its number, id)");
      return n;
    };
    appMethod("watch", async (p) => (await pool.keep(id(p)), { url: (await pool.watch(id(p))) ?? null }));
    appMethod("tell", async (p) => ({ told: pool.tell(id(p), String(p.message ?? "")) }));
    appMethod("stop", async (p) => ({ stopped: pool.stop(id(p)) }));
    appMethod("remove", async (p) => {
      const removed = (await pool.remove(id(p))) || (await pool.forget(id(p)));
      tasks.forget(id(p));
      return { removed };
    });
  }
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, send, vms: vms.vms, route: api.route };
  const observers = await Promise.all(plugins.flatMap((p) => (p.observe ? [p.observe(ctx)] : [])));
  for (const observer of observers) gate.observe(observer);
  for (const plugin of plugins) if (plugin.llm) gate.serve(await plugin.llm(ctx));

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  gate.add(memoryTools(db, recalls));
  gate.add(localTools(vms.tools));
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");

  // The main agent's sessions, as events for the owner's apps (numbered like tasks; "main", the owner's texts, is 0):
  // what the owner said, each tool call and message as it goes, and "replied" once a turn is done.
  const turn = await connectAgent(sockets, {
    db,
    sql: sqlBridge(`${dir}/durable.db`, env("DB_KEY")),
    prompt,
    models,
    gate: gate.handle,
    env: (id, args, socket) => vms.vms.env(id, args, socket),
    board: tasks,
  });

  // A message into a main session (a wake, a task report; or the owner's, `fromOwner`): the agent's reply, which in
  // "main" also goes to the owner's texts. Other sessions answer only in the app they're in.
  async function deliver(text: string, image?: Buffer, session = "main", fromOwner = false) {
    const done = observers.map((o) => o.turn?.(outbound(text).text));
    try {
      const reply = (await turn(text, session, fromOwner ? "user" : "systemNotification"))?.replace(LOCKS, "").trim();
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
  await api.listen();
  return { db, channel, handle, vms: vms.vms };
}
