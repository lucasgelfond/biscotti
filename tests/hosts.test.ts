import { existsSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { appMethods } from "../core/src/plugin.ts";
import { type Host, taskEvents } from "../plugins/tasks/types.ts";
import { model } from "./stand-in-model.ts";
import { standInVms } from "./stand-in-vm.ts";
import { until as wait } from "./wait.ts";

// Every kind of machine tasks run on is asked the same things (Host, plugins/tasks/types.ts), so every one passes this
// suite, through the whole stack: the real gate and agent with a scripted model, each task's commands run in its VM
// through pi-env. The stand-in (pi-env's daemon on this machine) always. A real host where there is one:
// HOST=firecracker on a machine with the vms service (the Pi or an EC2 node, its live service stopped, which holds the
// slots and the gate's ports).

// A newcomer waiting for a VM that couldn't be put to sleep tries again this often.
process.env.VM_USE_CHECK_MS ??= "2000";
const { boot } = await import("./support.ts");
afterAll(() => void model.close());

async function hostUnderTest(): Promise<{ host: Host; slots: number; close(): void; full?: (is?: boolean) => void }> {
  if (process.env.HOST === "firecracker") {
    const { localHost, SLOTS } = await import("../plugins/firecracker/index.ts");
    if (!process.env.VMS_SOCKET || !existsSync(process.env.VMS_SOCKET)) throw new Error("HOST=firecracker needs VMS_SOCKET, the vms service's socket");
    return { host: localHost(process.env.VMS_SOCKET, process.env.VM_DIR ?? "/var/lib/biscotti/vm"), slots: SLOTS.length, close: () => {} };
  }
  const stand = await standInVms([1, 2]);
  return { host: stand.host, slots: 2, close: stand.close, full: stand.full };
}
const under = await hostUnderTest();
afterAll(() => under.close());
const { say, sent } = await boot(["ssh-vms"], { vms: under.host });

const until = (check: () => boolean, ms = 120_000) => wait(check, ms);
// What happens to each task (its number from when it's queued), and its report.
const ids: number[] = [];
const states = new Map<number, string>();
const reports = new Map<number, string>();
taskEvents.on("event", (e) => {
  if (e.type === "queued") ids.push(e.id);
  else states.set(e.id, e.type);
  if (e.type === "report") reports.set(e.id, e.text ?? "");
});
// The owner asks for a task: its number, once it's queued (the main agent may be busy with a report, and take it
// as soon as it's done).
async function start(text: string) {
  const before = ids.length;
  await say(text);
  await until(() => ids.length > before);
  return ids[before];
}

test("a task's command runs in a fresh VM, and its report reaches the owner", async () => {
  const id = await start("start a task: run `uname -s > here.txt && echo hello-from-$(cat here.txt)`");
  await until(() => reports.has(id));
  expect(reports.get(id)).toMatch(/done: hello-from-(Linux|Darwin)/);
  // The main agent got it, and answered the owner.
  await until(() => sent.some((t) => t.includes("Task report") && t.includes("hello-from-")));
}, 180_000);

test("tasks run side by side, one per slot, and one more waits for a slot", async () => {
  const mine: number[] = [];
  let most = 0;
  const watch = setInterval(() => (most = Math.max(most, mine.filter((id) => states.get(id) === "started").length)), 20);
  for (let n = 0; n <= under.slots; n++) mine.push(await start(`start a task: run \`sleep 2 && echo side-${n}\``));
  expect(mine).toHaveLength(under.slots + 1);
  await until(() => mine.every((id) => reports.has(id)));
  clearInterval(watch);
  expect(most).toBe(under.slots);
  mine.forEach((id, n) => expect(reports.get(id)).toContain(`side-${n}`));
}, 240_000);

test("a kept task's follow-up runs in the same VM, with what its first run left there", async () => {
  const id = await start("start a kept task: run `echo first-run > note.txt && cat note.txt`");
  await until(() => reports.has(id));
  expect(reports.get(id)).toContain("first-run");
  reports.delete(id);
  await say(`tell task ${id}: run \`cat note.txt && echo second-run\``);
  await until(() => reports.has(id));
  expect(reports.get(id)).toContain("first-run");
  expect(reports.get(id)).toContain("second-run");
}, 240_000);

test("stopping a running task ends it with a report, and its slot goes to the next", async () => {
  const id = await start("start a task: run `sleep 60 && echo too-late`");
  await until(() => states.get(id) === "started");
  await new Promise((r) => setTimeout(r, 1500));
  await say(`stop task ${id}`);
  await until(() => states.get(id) === "failed" || reports.has(id), 60_000);
  expect(reports.get(id) ?? "").not.toContain("too-late");
  const next = await start("start a task: run `echo after-the-stop`");
  await until(() => reports.has(next));
  expect(reports.get(next)).toContain("after-the-stop");
}, 240_000);

test("a VM to ssh into is set up with the owner's key, kept when closed, and the same VM when reopened", async () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnerKeyForTheHostSuite owner@test";
  const open = appMethods.get("vms.open")!;
  const vm = (await open({ key }, new AbortController().signal)) as { id: number; hostKey?: string; ssh: { port: number } };
  expect(vm.hostKey).toMatch(/^ssh-ed25519 /);
  await appMethods.get("vms.close")!({ id: vm.id }, new AbortController().signal);
  await until(() => states.get(vm.id) === "kept");
  const again = (await appMethods.get("vms.reopen")!({ id: vm.id, key }, new AbortController().signal)) as { id: number };
  expect(again.id).toBe(vm.id);
  const gone = (await appMethods.get("vms.close")!({ id: vm.id, discard: true }, new AbortController().signal)) as { discarded: boolean };
  expect(gone.discarded).toBe(true);
}, 240_000);

test("a kept VM goes to sleep when its slot is needed, and wakes for a follow-up with its files", async () => {
  // Every slot held by a kept task's VM.
  const kept: number[] = [];
  for (let n = 0; n < under.slots; n++) {
    kept.push(await start(`start a kept task: run \`echo kept-${n} > mine.txt && cat mine.txt\``));
    await until(() => reports.has(kept[n]));
  }
  // One more task: the VM used longest ago sleeps (suspended, kept on disk) to make room.
  const next = await start("start a task: run `echo needs-a-slot`");
  await until(() => reports.has(next));
  expect(reports.get(next)).toContain("needs-a-slot");
  await until(() => kept.some((id) => states.get(id) === "kept"));
  const asleep = kept.find((id) => states.get(id) === "kept")!;
  // Its follow-up wakes it (resumed from disk) with what it left there.
  reports.delete(asleep);
  await say(`tell task ${asleep}: run \`cat mine.txt\``);
  await until(() => reports.has(asleep));
  expect(reports.get(asleep)).toContain(`kept-${kept.indexOf(asleep)}`);
}, 240_000);

// A full disk can't be faked on a real machine, so only on the stand-in.
test.skipIf(!under.full)("a kept VM that can't be put to sleep (a full disk) stays open with its files, and the newcomer waits until one can", async () => {
  const kept: number[] = [];
  for (let n = 0; n < under.slots; n++) {
    kept.push(await start(`start a kept task: run \`echo full-${n} > mine.txt && cat mine.txt\``));
    await until(() => reports.has(kept[n]));
  }
  const notes: [number, string][] = [];
  const note = (e: { id: number; text?: string }) => void (e.text && notes.push([e.id, e.text]));
  taskEvents.on("event", note);
  under.full!(true);
  const next = await start("start a task: run `echo after-the-disk-is-freed`");
  await until(() => notes.some(([id, text]) => kept.includes(id) && text.startsWith("Couldn't be put to sleep")));
  expect(reports.has(next)).toBe(false);
  // Nothing was lost: a kept VM's follow-up still finds its files.
  const first = kept[0];
  reports.delete(first);
  await say(`tell task ${first}: run \`cat mine.txt\``);
  await until(() => reports.has(first));
  expect(reports.get(first)).toContain("full-0");
  // Once saves work again, a VM goes to sleep and the newcomer runs.
  under.full!(false);
  await until(() => reports.has(next));
  expect(reports.get(next)).toContain("after-the-disk-is-freed");
  expect(kept.some((id) => states.get(id) === "kept")).toBe(true);
  taskEvents.off("event", note);
}, 240_000);
