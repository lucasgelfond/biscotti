import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import type { Host } from "../core/src/plugin.ts";

// Task VMs on this machine, for tests and the dev host: each slot's "VM" is pi-env's own daemon here, in a home of its
// own (`homes`), standing in for ssh into a task VM. Its setup (core/vm/task/biscotti-task's box mode) is a stand-in
// that records what it was asked (`setups`), checks a coding task's repo out in ~/repo as the VM's does (git only, no
// jj), and answers with a host key.
export async function standInVms(slots = [1, 2]) {
  const setups: { slot: number; box: { key?: string; repo?: string; setup?: string } }[] = [];
  const homes = new Map(slots.map((slot) => [slot, mkdtempSync(join(tmpdir(), `vm-${slot}-home-`))]));
  const checkout = (home: string, bundle: string) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", `${home}/repo`, ...args]);
    writeFileSync(`${home}/repo.bundle`, Buffer.from(bundle, "base64"));
    rmSync(`${home}/repo`, { recursive: true, force: true });
    execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "-q", `${home}/repo.bundle`, `${home}/repo`]);
    git("remote", "remove", "origin");
    git("checkout", "-q", "-b", "biscotti");
    git("config", "user.name", "biscotti");
    git("config", "user.email", "biscotti@users.noreply.github.com");
  };
  // Each slot's setup, on a port of its own.
  const boxes = new Map<number, Server>();
  for (const slot of slots) {
    const box = createServer((socket) => {
      let body = "";
      socket.on("data", (d) => (body += d)).on("end", () => {
        const asked = { slot, ...(JSON.parse(body) as { box: { key?: string; repo?: string; setup?: string } }) };
        setups.push(asked);
        if (asked.box.repo) checkout(homes.get(slot)!, asked.box.repo);
        socket.end(`${JSON.stringify({ type: "box", ok: true, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandInHostKeyForTheTestVm" })}\n`);
      });
    });
    await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
    boxes.set(slot, box);
  }
  // A VM put to sleep keeps its home, as a suspended one keeps its disk.
  const vm = (slot: number) => ({ slot, stop: async () => {}, suspend: async () => {} });
  const host: Host = {
    slots,
    restore: async (slot) => vm(slot),
    resume: async (slot) => vm(slot),
    discard: async () => {},
    endpoint: (slot, port) => (port === 4000 ? { host: "127.0.0.1", port: (boxes.get(slot)!.address() as { port: number }).port } : { host: "127.0.0.1", port }),
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
  return { host, setups, homes, close: () => boxes.forEach((b) => b.close()) };
}
