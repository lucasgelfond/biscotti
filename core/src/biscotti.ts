import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent.ts";
import crons from "./crons.ts";
import { createGate, LOCKS, readBody, scrub } from "./gate.ts";
import { memoryTools, openDb, searchableText } from "./memory.ts";
import { localTools, text, type Channel, type Context, type LocalTool, type Plugin, type TaskOptions } from "./plugin.ts";
import { transcripts } from "./schema.ts";
import { restore, SLOTS, taskTool, taskVms, vmService } from "./tasks.ts";
import vault, { secrets } from "./vault.ts";


function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Message = { text: string; react(emoji: string): Promise<unknown> };

// The gate: every key, the database, the channel and the plugins. `sockets` is the directory it shares with the main
// agent; with `agent: false` the agent runs elsewhere (its own container), otherwise in this process.
export async function start(opts: { plugins: Plugin[]; dir: string; sockets?: string; agent?: boolean }) {
  const { dir } = opts;
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
  const vmDir = process.env.VM_DIR;
  let vms: ReturnType<typeof taskVms> | undefined;
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver, task: vmDir ? task : undefined };

  const channelPlugin = plugins.find((p) => p.channel);
  if (!channelPlugin) throw new Error("biscotti.json needs a channel plugin, e.g. channels/spectrum");
  const channel: Channel = await channelPlugin.channel!(ctx);
  for (const plugin of plugins) if (plugin.tools) gate.add(await plugin.tools(ctx));
  const recalls = await Promise.all(plugins.flatMap((p) => (p.recall ? [p.recall(ctx)] : [])));

  if (vmDir) for (const slot of SLOTS) await gate.listen(`10.200.${slot}.1`, 80, { slot, peer: `10.200.${slot}.2` });
  // The vms service restores VMs where there is one (VMS_SOCKET); otherwise (development) this process does.
  const vmSocket = process.env.VMS_SOCKET;
  if (vmDir) vms = taskVms(vmSocket ? vmService(vmSocket) : (slot) => restore(vmDir, env("FIRECRACKER"), slot));

  async function task(goal: string, { model, ...opts }: TaskOptions = {}) {
    if (!vms) throw new Error("Task VMs aren't running yet.");
    let slot: number | undefined;
    try {
      return await vms.run(goal, (s) => ((slot = s), model && gate.route(s, model)), opts);
    } finally {
      if (slot) gate.route(slot);
    }
  }

  let latest: Message | undefined;
  const react: LocalTool = {
    name: "react",
    description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
    input: { type: "object", properties: { emoji: { type: "string" } }, required: ["emoji"] },
    async run({ emoji }) {
      await latest?.react(String(emoji));
      return text("Reacted.");
    },
  };

  // In the link's fragment, which the browser never sends to the server.
  const vncPassword = () => (existsSync(`${vmDir}/vnc-password`) ? readFileSync(`${vmDir}/vnc-password`, "utf8").trim() : "");
  const liveDesktop = process.env.LIVE_DESKTOP_URL ?? (process.env.TAILNET_HOST && `https://${process.env.TAILNET_HOST}`);
  const tasks = vms
    ? [
        taskTool(
          vms,
          (goal, { report, screenshot }) => deliver(`Task report (${goal}):\n${report}`, screenshot),
          liveDesktop ? (slot) => `${liveDesktop}:${10440 + slot}/vnc.html#autoconnect=1&password=${vncPassword()}` : undefined,
        ),
      ]
    : [];
  gate.add(memoryTools(db, recalls));
  gate.add(localTools([react, ...tasks]));
  const prompt = [readFileSync(new URL("../SYSTEM.md", import.meta.url), "utf8"), ...plugins.flatMap((p) => (p.prompt ? [p.prompt] : []))].join("\n\n");

  // The agent's way in: its model and tools, the system prompt, and its transcript, on a socket only it shares.
  const sockets = opts.sockets ?? mkdtempSync(join(tmpdir(), "biscotti-"));
  const agentSocket = createServer((req, res) => {
    if (req.url === "/prompt") return void res.end(prompt);
    if (req.url !== "/transcript") return gate.handle(req, res);
    if (req.method !== "POST") return void res.end(JSON.stringify(db.select({ entry: transcripts.entry }).from(transcripts).orderBy(transcripts.seq).all().map((r) => r.entry)));
    readBody(req).then(
      (body) => {
        const entries = JSON.parse(body) as FileEntry[];
        if (entries.length) db.insert(transcripts).values(entries.map((entry) => ({ id: entry.id, entry, text: searchableText(entry) }))).onConflictDoNothing().run();
        res.end();
      },
      (err) => res.writeHead(400).end(String(err)),
    );
  });
  rmSync(`${sockets}/gate.sock`, { force: true });
  await new Promise<void>((resolve) => agentSocket.listen(`${sockets}/gate.sock`, resolve));
  // Only the agent's user (uid 1000, in its own container) may connect.
  if (process.getuid?.() === 0) chownSync(`${sockets}/gate.sock`, 1000, 1000);
  chmodSync(`${sockets}/gate.sock`, 0o600);
  // In one process (tests, development), the agent runs alongside, and the gate answers on a loopback port too.
  let gateUrl: string | undefined;
  if (opts.agent !== false) {
    await runAgent(sockets, join(dir, "agent"));
    const server = await gate.listen("127.0.0.1", 0);
    gateUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  // One turn of the agent. It may still be starting (its own container in production).
  async function turn(message: string): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await post(`${sockets}/agent.sock`, JSON.stringify({ text: message }));
      } catch (err) {
        if (attempt >= 60 || !/ENOENT|ECONNREFUSED/.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

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
  return { db, gateUrl, channel, handle };
}

function post(socketPath: string, body: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    const req = request({ socketPath, method: "POST", path: "/turn", headers: { "Content-Type": "application/json" } }, (res) => {
      readBody(res).then((text) => (res.statusCode === 200 ? resolve(JSON.parse(text).reply) : reject(new Error(text))), reject);
    });
    req.on("error", reject).end(body);
  });
}

