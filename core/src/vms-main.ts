import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { listen } from "./http.ts";
import { restore, SLOTS, type Vm } from "./tasks.ts";

// The task VMs' service, in a container of its own: KVM, the slots' networks and the snapshot, and no keys, no data
// and no network. The gate asks it, over a socket only the two share, to restore a VM in a slot or to stop one.

const vmDir = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const firecracker = process.env.FIRECRACKER ?? "firecracker";
const sockets = process.env.VMS_SOCKETS ?? "/run/biscotti-vms";
// Slot N's Firecracker runs as uid base + N.
const uidBase = Number(process.env.TASK_UID_BASE ?? 1100);

// Firecracker's sockets are its slot user's and group's (this service is in each slot's group), no one else's.
process.umask(0o007);

const running = new Map<number, Vm>();
async function stop(slot: number) {
  await running.get(slot)?.stop();
  running.delete(slot);
}

const server = createServer(async (req, res) => {
  const slot = Number(/^\/vms\/(\d+)$/.exec(req.url ?? "")?.[1]);
  if (!SLOTS.includes(slot)) return void res.writeHead(404).end();
  try {
    await stop(slot);
    if (req.method === "POST") running.set(slot, await restore(vmDir, firecracker, slot, uidBase + slot));
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500).end((err as Error).message);
  }
});

// Pull the snapshot's memory into the page cache.
createReadStream(`${vmDir}/desktop.mem`).on("error", () => {}).resume();
await listen(server, `${sockets}/vms.sock`);
