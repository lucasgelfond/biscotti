import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import { chatReducer, PROTOCOL_VERSION, type URI } from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import { afterAll, expect, test } from "vitest";
import WebSocket from "ws";
import type { Host } from "../core/src/plugin.ts";
import { model } from "./stand-in-model.ts";

// A task as the main agent runs it (agent-tasks.ts): the owner asks, the main agent starts a task, the gate sets up a
// VM and hands the run to the agent, whose task conversation runs a command in the VM through pi-env (the env pipe
// through the gate's socket), and the report comes back to the owner. The VM here is pi-env's own daemon on this
// machine, in a home of its own, standing in for ssh into a task VM; the box setup is a stand-in of the VM's.

const { boot } = await import("./support.ts");
afterAll(() => void model.close());

// The VM's setup (core/vm/task/biscotti-task's box mode): the key authorized, answered with its host key.
const set: unknown[] = [];
const box = createServer((socket) => {
  let body = "";
  socket.on("data", (d) => (body += d)).on("end", () => {
    set.push(JSON.parse(body));
    socket.end(`${JSON.stringify({ type: "box", ok: true, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandInHostKeyForTheTestVm" })}\n`);
  });
});
await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
const home = mkdtempSync(join(tmpdir(), "vm-home-"));
const vms: Host = {
  slots: [1],
  restore: async (slot) => ({ slot, stop: async () => {} }),
  endpoint: (_slot, port) => (port === 4000 ? { host: "127.0.0.1", port: (box.address() as { port: number }).port } : { host: "127.0.0.1", port }),
  gate: () => ({ host: "127.0.0.1", port: 0, peer: () => undefined }),
  async env(_slot, args, socket) {
    const daemon = spawn(localDaemon(), args, { cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: pi-env\r\nConnection: Upgrade\r\n\r\n");
    socket.pipe(daemon.stdin);
    daemon.stdout.pipe(socket);
    daemon.on("exit", () => socket.destroy());
    socket.on("close", () => daemon.kill()).on("error", () => daemon.kill());
  },
};
afterAll(() => void box.close());

const until = async (check: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("the main agent runs a task in its VM through pi-env and reports back", async () => {
  const { say, sent } = await boot([], undefined, undefined, vms);
  await say("start a task: run `echo hi-from-the-vm > made-here.txt && cat made-here.txt`");
  // The gate set the VM up with its own key, for pi-env over ssh.
  await until(() => set.length > 0);
  expect((set[0] as { box: { key: string } }).box.key).toMatch(/^ssh-ed25519 \S+ biscotti-gate$/);
  // The task's command ran in the VM (its home), and its report came back to the owner through the main agent.
  await until(() => sent.some((s) => s.includes("Task report")));
  const report = sent.find((s) => s.includes("Task report"))!;
  expect(report).toContain("done: hi-from-the-vm");
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(home, "made-here.txt"), "utf8").trim()).toBe("hi-from-the-vm");
}, 120_000);

// The owner's app, over AHP: the task is a sandbox chat of the session that started it, its turns the task's own.
class Socket implements AhpTransport {
  readonly #frames: TransportFrame[] = [];
  readonly #waiting: ((frame: TransportFrame | null) => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => {
      const frame: TransportFrame = { kind: "text", text: String(data) };
      const w = this.#waiting.shift();
      if (w) w(frame);
      else this.#frames.push(frame);
    });
    ws.on("close", () => this.#waiting.splice(0).forEach((w) => w(null)));
  }
  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  recv() {
    const frame = this.#frames.shift();
    return frame ? Promise.resolve(frame) : new Promise<TransportFrame | null>((r) => this.#waiting.push(r));
  }
  close() {
    this.ws.close();
  }
}

test("the app sees a task as a sandbox chat of its session, with the task's own turns", async () => {
  const { say, sockets } = await boot([], undefined, undefined, vms);
  await say("hello");
  const ws = new WebSocket(`ws+unix://${sockets}/agent.sock:/ahp`);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const c = new AhpClient(new Socket(ws));
  c.connect();
  await c.initialize({ clientId: "app", protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  const { result, subscription } = await c.subscribe("ahp-session:/main");
  const session = { state: result.snapshot!.state as { chats: { resource: string }[]; _meta?: { biscotti?: { chats?: Record<string, { kind: string; status: string }> } } } };
  void (async () => {
    for await (const event of subscription) {
      if (event.type !== "action") continue;
      const a = event.params.action as { type: string; summary?: { resource: string }; _meta?: typeof session.state._meta };
      if (a.type === "session/chatAdded") session.state.chats.push(a.summary!);
      if (a.type === "session/metaChanged") session.state._meta = a._meta;
    }
  })();

  await say("start a task: run `echo seen-in-the-app`");
  await until(() => session.state.chats.some((ch) => /^ahp-chat:\/main\/\d+$/.test(ch.resource)));
  const sandbox = session.state.chats.find((ch) => /^ahp-chat:\/main\/\d+$/.test(ch.resource))!.resource as URI;
  await until(() => session.state._meta?.biscotti?.chats?.[sandbox]?.status === "done");
  expect(session.state._meta?.biscotti?.chats?.[sandbox]?.kind).toBe("sandbox");

  const chat = await c.subscribe(sandbox);
  const state = chat.result.snapshot!.state as ReturnType<typeof chatReducer> & { turns: { message: { text: string }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string } }[] }[] };
  expect(state.turns[0].message.text).toBe("run `echo seen-in-the-app`");
  expect(state.turns[0].responseParts.find((p) => p.kind === "toolCall")?.toolCall?.toolName).toBe("bash");
  expect(state.turns[0].responseParts.map((p) => p.content)).toContain("done: seen-in-the-app");
  ws.close();
}, 120_000);
