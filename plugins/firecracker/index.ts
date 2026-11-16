import { existsSync, readFileSync } from "node:fs";
import type { Plugin } from "@biscotti/core";
import { type Host, stillRunning, type Vm, vms } from "@biscotti/tasks";
import { call } from "@biscotti/core/http";
import { SLOTS } from "./firecracker.ts";

// This machine's task VMs, from the vms service (vms-main.ts, a container of its own with KVM and nothing else) over
// its socket (VMS_SOCKET): one more machine for the pool, as external-vm-node's EC2 nodes are.

export { SLOTS };

// Each slot's VM is 10.200.<slot>.2 on its own link, the gate 10.200.<slot>.1 there (nix/net.nix). Their sshd is on
// the tailnet at 2200 + slot, their live desktops at 10440 + slot (`tailscale serve`), the password in the link's
// fragment, which the browser never sends to the server; their port 8000 (a preview of what a task made) at 10540 +
// slot.
export const endpoint = (slot: number, port: number) => ({ host: `10.200.${slot}.2`, port });
export const gateAt = (slot: number) => ({ host: `10.200.${slot}.1`, port: 80, peer: () => `10.200.${slot}.2` });
export function localHost(socketPath: string, vmDir: string): Host {
  const vm = (slot: number): Vm => ({
    slot,
    stop: async () => void (await call(socketPath, "DELETE", `/vms/${slot}`)),
    suspend: (id) => call(socketPath, "POST", `/vms/${slot}/suspend/${id}`).then(() => {}, stillRunning),
  });
  return {
    slots: SLOTS,
    endpoint,
    gate: gateAt,
    ssh: process.env.TAILNET_HOST ? (slot) => ({ host: process.env.TAILNET_HOST!, port: 2200 + slot }) : undefined,
    restore: async (slot) => (await call(socketPath, "POST", `/vms/${slot}`), vm(slot)),
    resume: async (slot, id) => (await call(socketPath, "POST", `/vms/${slot}/resume/${id}`), vm(slot)),
    discard: async (slot, id) => void (await call(socketPath, "DELETE", `/vms/${slot}/suspended/${id}`)),
    watch: process.env.TAILNET_HOST
      ? (slot) => `https://${process.env.TAILNET_HOST}:${10440 + slot}/biscotti.html#password=${existsSync(`${vmDir}/vnc-password`) ? readFileSync(`${vmDir}/vnc-password`, "utf8").trim() : ""}`
      : undefined,
    site: process.env.TAILNET_HOST ? (slot) => `https://${process.env.TAILNET_HOST}:${10540 + slot}/` : undefined,
    active: (slot) => sessions(slot) > 0,
  };
}

// Connections to the slot's VM's sshd or live desktop (10.200.<slot>.2, ports 22 and 6901), from this machine's
// network: the gate's (it shares the host's), where Tailscale passes them on.
export function sessions(slot: number, tables = ["/proc/net/tcp", "/proc/net/tcp6"]) {
  const vm = [2, slot, 200, 10].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const ports = new Set(["0016", "1AF5"]);
  let n = 0;
  for (const table of tables) {
    if (!existsSync(table)) continue;
    for (const line of readFileSync(table, "utf8").split("\n").slice(1)) {
      const [, , remote, state] = line.trim().split(/\s+/);
      if (state !== "01" || !remote) continue;
      const [ip, port] = remote.split(":");
      if (ip.endsWith(vm) && ports.has(port)) n++;
    }
  }
  return n;
}

export default {
  async start(ctx) {
    if (!process.env.VMS_SOCKET) return;
    await vms(ctx).addHost(localHost(process.env.VMS_SOCKET, ctx.env("VM_DIR")));
  },
} satisfies Plugin;
