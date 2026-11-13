import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { listen } from "./http.ts";
import { discard, restore, resume, SLOTS, suspend, type Vm } from "./tasks.ts";

// The task VMs' service, in a container of its own: KVM, the slots' networks and the snapshot, and no keys, no data
// and no network. The gate asks it, over a socket only the two share, to restore a VM in a slot or to stop one.

const vmDir = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const firecracker = process.env.FIRECRACKER ?? "firecracker";
const sockets = process.env.VMS_SOCKETS ?? "/run/biscotti-vms";
// Each slot's work disk, in WORK_DIR/<slot>, copied from the snapshot's (WORK_DIR/base.ext4) at each restore.
const workDir = process.env.WORK_DIR ?? "/var/lib/biscotti/work";
// Slot N's Firecracker runs as uid base + N.
const uidBase = Number(process.env.TASK_UID_BASE ?? 1100);

// Firecracker's sockets are its slot user's and group's (this service is in each slot's group), no one else's.
process.umask(0o007);

const running = new Map<number, Vm>();
async function stop(slot: number) {
  await running.get(slot)?.stop();
  running.delete(slot);
}

// POST /vms/<slot>: a fresh VM in the slot. DELETE: stop it. POST /vms/<slot>/suspend/<id>: pause and save it, freeing
// the slot. POST /vms/<slot>/resume/<id>: bring a saved one back there. DELETE /vms/<slot>/suspended/<id>: delete one.
const server = createServer(async (req, res) => {
  // The live desktops' password, for the gate of the machine this one runs VMs for (an overflow machine).
  if (req.url === "/vnc-password" && req.method === "GET") return void res.end(readFileSync(`${vmDir}/vnc-password`, "utf8"));
  const [, n, action, id] = /^\/vms\/(\d+)(?:\/(suspend|resume|suspended)\/(\d+))?$/.exec(req.url ?? "") ?? [];
  const slot = Number(n);
  if (!SLOTS.includes(slot)) return void res.writeHead(404).end();
  const uid = uidBase + slot;
  try {
    if (action === "suspend" && req.method === "POST") {
      const vm = running.get(slot);
      if (!vm) return void res.writeHead(409).end(`no VM in slot ${slot}`);
      running.delete(slot);
      await suspend(vm, workDir, uid, id);
    } else if (action === "suspended" && req.method === "DELETE") {
      await discard(workDir, slot, uid, id);
    } else if (action === "resume" && req.method === "POST") {
      await stop(slot);
      running.set(slot, await resume(vmDir, firecracker, slot, uid, workDir, id));
    } else if (!action) {
      await stop(slot);
      if (req.method === "POST") running.set(slot, await restore(vmDir, firecracker, slot, uid, workDir));
    } else return void res.writeHead(404).end();
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500).end((err as Error).message);
  }
});

// Pull the snapshot's memory into the page cache.
createReadStream(`${vmDir}/desktop.mem`).on("error", () => {}).resume();
await listen(server, `${sockets}/vms.sock`);
