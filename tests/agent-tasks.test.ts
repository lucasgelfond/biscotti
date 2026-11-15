import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import { afterAll, expect, test } from "vitest";
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
