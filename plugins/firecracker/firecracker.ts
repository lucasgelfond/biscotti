import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { promisify } from "node:util";
import { call } from "@biscotti/core/http";

// This machine's slots, 1 to VM_SLOTS.
export const SLOTS = Array.from({ length: Number(process.env.VM_SLOTS ?? 2) }, (_, i) => i + 1);

// Firecracker VMs for the vms service (vms-main.ts): each slot's VM restored from the snapshot, saved for a follow-up
// and brought back.

export interface FirecrackerVm {
  slot: number;
  stop(): Promise<void>;
  // Its API socket.
  api: string;
}

// Restores take turns while one points the work disk's path (the one the snapshot remembers) at its slot's copy, until
// its Firecracker has opened it.
let disks = Promise.resolve();
const turn = <T>(f: () => Promise<T>) => {
  const done = disks.then(f);
  disks = done.then(() => {}, () => {});
  return done;
};

// Runs a command as the slot's own user (`uid`), with no capabilities, like Firecracker's jailer.
export const slotUser = (uid: number) => ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, `--groups=${statSync("/dev/kvm").gid}`, "--inh-caps=-all", "--no-new-privs", "--"];
export const asSlot = (uid: number, ...cmd: string[]) => {
  const as = slotUser(uid);
  return promisify(execFile)(as[0], [...as.slice(1), ...cmd], { env: { PATH: process.env.PATH } });
};

// Points `current`, the work disk's path in every snapshot, at `disk`.
function pointAt(workDir: string, disk: string) {
  rmSync(`${workDir}/current.new`, { force: true });
  symlinkSync(disk, `${workDir}/current.new`);
  renameSync(`${workDir}/current.new`, `${workDir}/current`);
}

// A fresh work disk for the slot: a sparse copy of the one the snapshot was taken with, made as the slot's user, in the
// slot's own directory (no other slot's user can read it); then `current` points there.
async function workDisk(workDir: string, slot: number, uid: number) {
  const disk = `${workDir}/${slot}/work.ext4`;
  await asSlot(uid, "cp", "--sparse=always", "--reflink=auto", `${workDir}/base.ext4`, `${disk}.new`);
  await asSlot(uid, "mv", `${disk}.new`, disk);
  pointAt(workDir, disk);
}

// Firecracker in the slot's namespace, as the slot's own user (`uid`) with no capabilities, like Firecracker's jailer.
// With a work disk (`workDir`, from a snapshot built with one), the VM writes there rather than to RAM.
export async function restore(vmDir: string, firecracker: string, slot: number, uid: number, workDir?: string): Promise<FirecrackerVm> {
  const as = slotUser(uid);
  if (workDir && existsSync(`${workDir}/base.ext4`)) return turn(async () => (await workDisk(workDir, slot, uid), start(vmDir, firecracker, slot, as)));
  return start(vmDir, firecracker, slot, as);
}

// A suspended VM's files, in its slot's directory: its snapshot, its memory and its work disk.
export const suspendedDir = (workDir: string, slot: number, id: string) => `${workDir}/${slot}/suspended/${id}`;

// Pauses the VM and saves it (snapshot, memory, work disk) as `id`, then stops it. A full snapshot writes all of the VM's
// memory, so this takes as long as writing that much to the disk. One that can't be saved (a full disk, say) carries
// on where it was, what it wrote gone, and the error says so (`running`).
export async function suspend(vm: FirecrackerVm, workDir: string, uid: number, id: string) {
  const dir = suspendedDir(workDir, vm.slot, id);
  // Written beside the last save: a VM resumed from it still has that memory file mapped until it stops.
  await asSlot(uid, "rm", "-rf", `${dir}.new`);
  await asSlot(uid, "mkdir", "-p", `${dir}.new`);
  await call(vm.api, "PATCH", "/vm", JSON.stringify({ state: "Paused" }));
  try {
    await call(vm.api, "PUT", "/snapshot/create", JSON.stringify({ snapshot_type: "Full", snapshot_path: `${dir}.new/vm.snap`, mem_file_path: `${dir}.new/vm.mem` }));
  } catch (err) {
    await asSlot(uid, "rm", "-rf", `${dir}.new`).catch(() => {});
    await call(vm.api, "PATCH", "/vm", JSON.stringify({ state: "Resumed" }));
    throw Object.assign(err as Error, { running: true });
  }
  await vm.stop();
  await asSlot(uid, "rm", "-rf", dir);
  await asSlot(uid, "mv", `${dir}.new`, dir);
  if (existsSync(`${workDir}/base.ext4`)) await asSlot(uid, "mv", `${workDir}/${vm.slot}/work.ext4`, `${dir}/work.ext4`);
}

// The VM suspended as `id`, back in its slot where it left off. Its saved files go once it's running again (the memory
// file stays mapped), the work disk back to the slot's own path.
export async function resume(vmDir: string, firecracker: string, slot: number, uid: number, workDir: string, id: string): Promise<FirecrackerVm> {
  const dir = suspendedDir(workDir, slot, id);
  const vm = await turn(async () => {
    if (existsSync(`${workDir}/base.ext4`)) {
      await asSlot(uid, "mv", `${dir}/work.ext4`, `${workDir}/${slot}/work.ext4`);
      pointAt(workDir, `${workDir}/${slot}/work.ext4`);
    }
    return start(vmDir, firecracker, slot, slotUser(uid), { snapshot: `${dir}/vm.snap`, mem: `${dir}/vm.mem` });
  });
  await asSlot(uid, "rm", "-f", `${dir}/vm.snap`);
  return vm;
}

export const discard = (workDir: string, slot: number, uid: number, id: string) => asSlot(uid, "rm", "-rf", suspendedDir(workDir, slot, id)).then(() => {});

async function start(vmDir: string, firecracker: string, slot: number, as: string[], from = { snapshot: `${vmDir}/desktop.snap`, mem: `${vmDir}/desktop.mem` }): Promise<FirecrackerVm> {
  const sock = `/tmp/fc-${slot}.sock`;
  rmSync(sock, { force: true });
  const vm = spawn("nsenter", [`--net=/run/netns/fc${slot}`, ...as, firecracker, "--api-sock", sock], { stdio: "ignore", env: { PATH: process.env.PATH } });
  // A snapshot on huge pages (for nested virtualization, where every 4K page first touched is slow) can't be loaded
  // from the file directly: the handler copies it all in at the first fault.
  const handler = process.env.UFFD_HANDLER;
  const uffd = `/tmp/uffd-${slot}.sock`;
  let pager: ReturnType<typeof spawn> | undefined;
  // The next VM in this slot can't open the tap until this one has exited.
  const stop = async () => {
    const exited = vm.exitCode === null && vm.signalCode === null ? once(vm, "exit") : undefined;
    vm.kill("SIGKILL");
    pager?.kill("SIGKILL");
    await exited;
  };
  try {
    let exited = false;
    vm.once("exit", () => (exited = true));
    while (!existsSync(sock)) {
      if (exited) throw new Error(`firecracker didn't start in slot ${slot}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    if (handler) {
      rmSync(uffd, { force: true });
      pager = spawn(as[0], [...as.slice(1), handler, uffd, from.mem], { stdio: "ignore", env: { PATH: process.env.PATH } });
      while (!existsSync(uffd)) await new Promise((r) => setTimeout(r, 5));
    }
    await call(sock, "PUT", "/snapshot/load", JSON.stringify({
      snapshot_path: from.snapshot,
      mem_backend: handler ? { backend_type: "Uffd", backend_path: uffd } : { backend_type: "File", backend_path: from.mem },
      resume_vm: true,
    }));
    return { slot, stop, api: sock };
  } catch (err) {
    await stop();
    throw err;
  }
}
