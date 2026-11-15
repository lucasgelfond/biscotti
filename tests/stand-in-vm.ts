import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import type { Host } from "../core/src/plugin.ts";

// Task VMs on this machine, for tests and the dev host: each slot's "VM" is pi-env's own daemon here, in a home of its
// own (`homes`), standing in for ssh into a task VM; its setup (core/vm/task/biscotti-task's box mode) is a stand-in
// that records what it was asked (`setups`) and answers with a host key.
export async function standInVms(slots = [1, 2]) {
  const setups: { box: { key?: string; repo?: string; setup?: string } }[] = [];
  const box = createServer((socket) => {
    let body = "";
    socket.on("data", (d) => (body += d)).on("end", () => {
      setups.push(JSON.parse(body));
      socket.end(`${JSON.stringify({ type: "box", ok: true, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandInHostKeyForTheTestVm" })}\n`);
    });
  });
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
  const homes = new Map(slots.map((slot) => [slot, mkdtempSync(join(tmpdir(), `vm-${slot}-home-`))]));
  const host: Host = {
    slots,
    // A VM put to sleep keeps its home, as a suspended one keeps its disk.
    restore: async (slot) => ({ slot, stop: async () => {}, suspend: async () => {} }),
    resume: async (slot) => ({ slot, stop: async () => {}, suspend: async () => {} }),
    discard: async () => {},
    endpoint: (_slot, port) => (port === 4000 ? { host: "127.0.0.1", port: (box.address() as { port: number }).port } : { host: "127.0.0.1", port }),
    gate: () => ({ host: "127.0.0.1", port: 0, peer: () => undefined }),
    async env(slot, args, socket) {
      const home = homes.get(slot)!;
      const daemon = spawn(localDaemon(), args, { cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: pi-env\r\nConnection: Upgrade\r\n\r\n");
      socket.pipe(daemon.stdin);
      daemon.stdout.pipe(socket);
      daemon.on("exit", () => socket.destroy());
      socket.on("close", () => daemon.kill()).on("error", () => daemon.kill());
    },
  };
  return { host, setups, homes, close: () => box.close() };
}
