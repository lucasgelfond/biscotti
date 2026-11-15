import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import type { Host } from "../core/src/plugin.ts";

// Task VMs on this machine, for tests and the dev host: a slot's "VM" is pi-env's own daemon here in a home of its
// own, standing in for ssh into a task VM. As with a real one, a VM restored into a slot starts fresh (a new home), one
// suspended keeps its home to resume with, and one discarded loses it. Its setup (the VM image's, on port 4000) records
// what it was asked (`setups`), checks a coding task's repo out in ~/repo as the VM's does (git only, no jj), and
// answers with a host key. `fail` makes the next restores fail, and `full` every save, for tests of what happens then.
export async function standInVms(slots = [1, 2], label?: string) {
  const setups: { slot: number; box: { key?: string; repo?: string; setup?: string } }[] = [];
  const fresh = () => mkdtempSync(join(tmpdir(), "vm-home-"));
  // Each slot's VM's home now, and each suspended VM's.
  const homes = new Map<number, string>();
  const suspended = new Map<number, string>();
  let failing = 0;
  let full = false;
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
  const vm = (slot: number) => ({
    slot,
    stop: async () => void homes.delete(slot),
    async suspend(id: number) {
      if (full) throw Object.assign(new Error("no space left on the stand-in's disk"), { running: true });
      suspended.set(id, homes.get(slot)!);
      homes.delete(slot);
    },
  });
  const host: Host = {
    ...(label && { label }),
    slots,
    async restore(slot) {
      if (failing > 0) throw (failing--, new Error("the stand-in VM wouldn't start"));
      homes.set(slot, fresh());
      return vm(slot);
    },
    async resume(slot, id) {
      const home = suspended.get(id);
      if (!home) throw new Error(`no VM #${id} suspended here`);
      suspended.delete(id);
      homes.set(slot, home);
      return vm(slot);
    },
    discard: async (_slot, id) => void suspended.delete(id),
    endpoint: (slot, port) => (port === 4000 ? { host: "127.0.0.1", port: (boxes.get(slot)!.address() as { port: number }).port } : { host: "127.0.0.1", port }),
    gate: () => ({ host: "127.0.0.1", port: 0, peer: () => undefined }),
    async env(slot, args, socket) {
      const home = homes.get(slot);
      if (!home) throw new Error(`no VM in slot ${slot}`);
      const daemon = spawn(localDaemon(), args, { cwd: home, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: pi-env\r\nConnection: Upgrade\r\n\r\n");
      socket.pipe(daemon.stdin);
      daemon.stdout.pipe(socket);
      daemon.on("exit", () => socket.destroy());
      socket.on("close", () => daemon.kill()).on("error", () => daemon.kill());
    },
  };
  return {
    host,
    setups,
    // The home of the VM in a slot now.
    home: (slot: number) => homes.get(slot),
    fail: (times = 1) => void (failing += times),
    // A full disk: VMs can't be saved (suspend fails, the VM carrying on).
    full: (is = true) => void (full = is),
    close: () => boxes.forEach((b) => b.close()),
  };
}
