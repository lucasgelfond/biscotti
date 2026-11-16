import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type AddressInfo, type Server } from "node:net";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import type { TaskRun } from "../core/src/agent-tasks.ts";
import { localTools, taskEvents, text, type Caller, type Host, type Vm } from "../core/src/plugin.ts";

// The task pool's bookkeeping with stand-in VMs: what's running, stopping one, when a task counts as quiet, kept VMs
// and leases. Read before tasks.ts loads.
process.env.TASK_IDLE_MS = "400";
process.env.VM_USE_CHECK_MS = "30";
const { taskVms, gateTasks, vmCheck } = await import("../core/src/tasks.ts");
const { sessions } = await import("../plugins/firecracker/index.ts");

// The task agent (the main agent's, agent-tasks.ts), its run's lines: "silent" says nothing, "wait <ms>" says nothing
// for that long and then reports, anything else is reported at once. A follow-up is reported as "followup <message>".
function lines(task: TaskRun) {
  const stream = new PassThrough();
  const said = task.followup ? `followup ${task.goal}` : task.goal;
  if (said !== "silent")
    setTimeout(() => stream.end(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done: ${said}` }] } })}\n`), Number(said.match(/^wait (\d+)/)?.[1] ?? 0));
  return stream;
}
const run = async (_slot: number, task: TaskRun) => lines(task);
const agent = { key: () => "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandIn gate", trust: () => {}, pipe: async () => {}, run: async (task: TaskRun) => lines(task) };
// A pool whose tasks that agent runs.
const pool = (hooks: Parameters<typeof taskVms>[1] = {}, saved?: string) => taskVms([], { run, ...hooks }, saved);

// The VM's setup (its box mode, for pi-env): done at once.
async function setup() {
  const server = createServer((socket) => socket.on("data", () => socket.end(`${JSON.stringify({ type: "box", ok: true })}\n`)).on("error", () => {})).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

// A host of `slots` whose VMs are set up at once, recording what's done to them in `log`.
async function host(slots: number[], log: string[] = [], extra: Partial<Host> = {}): Promise<Host> {
  const address = await setup();
  const vm = (slot: number): Vm => ({ slot, stop: async () => void log.push(`stop ${slot}`), suspend: async (id) => void log.push(`suspend ${slot} ${id}`) });
  return {
    slots,
    restore: async (slot) => vm(slot),
    resume: async (slot, id) => (log.push(`resume ${slot} ${id}`), vm(slot)),
    discard: async (slot, id) => void log.push(`discard ${slot} ${id}`),
    endpoint: (_slot, port) => (port === 4000 ? address : { host: "127.0.0.1", port }),
    ...extra,
  };
}
const file = () => join(mkdtempSync(join(tmpdir(), "pool-")), "tasks.json");
const until = async (check: () => boolean) => {
  while (!check()) await new Promise((r) => setTimeout(r, 10));
};

test("lists running and queued tasks, and stopping one frees its slot for the queued one", async () => {
  const vms = pool({ busy: () => true });
  await vms.addHost(await host([1, 2]));
  const runs = ["silent", "silent", "silent"].map((goal) => vms.run(goal).result.catch((err: Error) => err.message));
  await until(() => vms.running().filter((t) => t.slot).length === 2);

  expect(vms.running().map(({ id, slot }) => ({ id, slot }))).toEqual([{ id: 1, slot: 1 }, { id: 2, slot: 2 }, { id: 3, slot: undefined }]);
  expect(vms.stop(1)).toBe(true);
  expect(await runs[0]).toBe("the task was stopped");
  await until(() => vms.running().find((t) => t.id === 3)?.slot !== undefined);
  expect(vms.running().map((t) => t.id)).toEqual([2, 3]);
  expect(vms.stop(99)).toBe(false);
  vms.stop(2);
  vms.stop(3);
});

test("a task in a tool call (like waiting on the owner's yes) isn't quiet; one that's only silent is", async () => {
  let inToolCall = true;
  const vms = pool({ busy: () => inToolCall });
  await vms.addHost(await host([1]));

  expect((await vms.run("wait 1200").result).report).toBe("done: wait 1200");
  inToolCall = false;
  await expect(vms.run("silent").result).rejects.toThrow("the task went quiet");
});

test("a finished task's VM is deleted, and numbering carries on after a restart", async () => {
  const log: string[] = [];
  const saved = file();
  const vms = pool({}, saved);
  await vms.addHost(await host([1], log));
  expect((await vms.run("find flights").result).report).toBe("done: find flights");
  expect(log).toContain("stop 1");
  expect(log.some((l) => l.startsWith("suspend"))).toBe(false);
  expect(vms.alive()).toEqual([]);
  expect(vms.resume(1, "book the second one")).toBe(false);

  const again = pool({}, saved);
  expect(again.reserve()).toBe(2);
});

test("a task kept open stays running once done, takes a follow-up in the same VM, and is deleted when told", async () => {
  const log: string[] = [];
  const vms = pool({}, file());
  await vms.addHost(await host([1, 2], log));
  const { id, result } = vms.run("fix the bug", { keep: true });
  await result;
  expect(log).not.toContain(`stop ${vms.slotOf(id)}`);
  expect(vms.alive()).toMatchObject([{ id, asleep: false, goal: "fix the bug" }]);
  vms.note(id, { pr: "https://github.com/o/r/pull/7" });
  expect(vms.alive()[0].pr).toBe("https://github.com/o/r/pull/7");

  const slot = vms.slotOf(id);
  const followup = vms.resume(id, "and the docs");
  expect(followup && (await followup).report).toBe("done: followup and the docs");
  expect(vms.slotOf(id)).toBe(slot);
  expect(log.some((l) => l.startsWith("resume"))).toBe(false);
  expect(vms.alive().map((v) => v.id)).toEqual([id]);

  expect(await vms.remove(id)).toBe(true);
  expect(log).toContain(`stop ${slot}`);
  expect(vms.alive()).toEqual([]);
});

test("asking to keep a running task keeps it open; asking for an asleep one wakes it; a plugin's VM put back is listed asleep", async () => {
  const log: string[] = [];
  const vms = pool({}, file());
  await vms.addHost(await host([1, 2], log));
  const { id, result } = vms.run("wait 200");
  expect(await vms.keep(id)).toBe(true);
  await result;
  expect(vms.alive().map((v) => [v.id, v.asleep])).toEqual([[id, false]]);
  await vms.remove(id);

  const box = await vms.hold("VM on o/r");
  await vms.give(box.id);
  expect(vms.alive().map((v) => [v.id, v.asleep])).toEqual([[box.id, true]]);
  expect(await vms.keep(box.id)).toBe(true);
  expect(log).toContain(`resume ${vms.slotOf(box.id)} ${box.id}`);
  expect(vms.alive().map((v) => [v.id, v.asleep])).toEqual([[box.id, false]]);
  // Reopened by its plugin as it is.
  expect((await vms.reclaim(box.id))?.slot).toBe(vms.slotOf(box.id));
  expect(await vms.keep(999)).toBe(false);
  expect(await vms.remove(999)).toBe(false);
});

test("an open VM counts as used while someone's on it", async () => {
  let on = false;
  const vms = pool({}, file());
  await vms.addHost(await host([1], [], { active: () => on }));
  const { id } = await vms.hold("VM on o/r");
  const opened = vms.alive()[0].used;
  await new Promise((r) => setTimeout(r, 120));
  expect(vms.alive()[0].used).toBe(opened);
  on = true;
  await until(() => vms.alive()[0].used > opened);
  await vms.give(id, false);
});

test("the daily check lists what's still around, what each is and which are idle over a day", () => {
  const now = Date.UTC(2026, 10, 15, 15);
  expect(vmCheck([], now)).toBeUndefined();
  const check = vmCheck(
    [
      { id: 31, goal: "Repo: o/r. Fix\nthe login bug", asleep: true, used: now - 3 * 86400_000, pr: "https://github.com/o/r/pull/9" },
      { id: 47, goal: "VM on o/site", asleep: false, used: now - 20 * 60_000 },
    ],
    now,
  )!;
  expect(check).toContain("- #31 (asleep, last used 3 days ago, idle over a day, pull request https://github.com/o/r/pull/9): Repo: o/r. Fix the login bug");
  expect(check).toContain("- #47 (open, last used 20 min ago): VM on o/site");
  expect(check).toContain("delete_vms");
});

test("ssh and desktop sessions on a slot's VM are counted from the host's TCP table", () => {
  const dir = mkdtempSync(join(tmpdir(), "tcp-"));
  // 10.200.1.2:22 and 10.200.1.2:6901 established, a closed one and the VM's own connection to the gate (10.200.1.1:80).
  const table = `  sl  local_address rem_address   st
   0: 0100007F:B3C2 0201C80A:0016 01 00000000:00000000
   1: 0100007F:B3C3 0201C80A:1AF5 01 00000000:00000000
   2: 0100007F:B3C4 0201C80A:0016 06 00000000:00000000
   3: 0101C80A:0050 0201C80A:CE86 01 00000000:00000000
`;
  writeFileSync(join(dir, "tcp"), table);
  expect(sessions(1, [join(dir, "tcp")])).toBe(2);
  expect(sessions(2, [join(dir, "tcp")])).toBe(0);
});

test("a plugin holds a VM, keeps it, brings it back and deletes it, numbered with the tasks", async () => {
  const log: string[] = [];
  const vms = pool({}, file());
  await vms.addHost(await host([1], log));
  const { id, vm } = await vms.hold("VM on o/r");
  expect([id, vm.slot]).toEqual([1, 1]);
  // Listed as kept by the time it says so, for the board.
  let keptWhenSaid: number[] = [];
  const onKept = (e: { type: string }) => e.type === "kept" && (keptWhenSaid = vms.kept().map((k) => k.id));
  taskEvents.on("event", onKept);
  await vms.give(id);
  taskEvents.off("event", onKept);
  expect(keptWhenSaid).toEqual([1]);
  expect(vms.kept().map((k) => k.goal)).toEqual(["VM on o/r"]);

  expect((await vms.reclaim(id))?.slot).toBe(1);
  await vms.give(id);
  expect(await vms.forget(id)).toBe(true);
  expect(log).toContain("discard 1 1");
  expect(vms.kept()).toEqual([]);
  expect(await vms.forget(id)).toBe(false);
});

test("when every slot holds a VM that may sleep, the one used longest ago sleeps for a newcomer; one without waits", async () => {
  const log: string[] = [];
  const vms = pool({}, file());
  await vms.addHost(await host([1, 2], log));
  const used = new Map<number, number>();
  const sleeper = (id: () => number) => ({ used: () => used.get(id()) ?? 0, sleep: () => vms.give(id()) });
  let a = 0;
  let b = 0;
  a = (await vms.hold("VM a", { sleep: sleeper(() => a) })).id;
  used.set(a, 2000);
  b = (await vms.hold("VM b", { sleep: sleeper(() => b) })).id;
  used.set(b, 1000);
  const slotOfB = vms.slotOf(b);

  const c = await vms.hold("VM c");
  expect(c.vm.slot).toBe(slotOfB);
  expect(log).toContain(`suspend ${slotOfB} ${b}`);
  expect(vms.kept().map((k) => k.id)).toEqual([b]);

  // Now one slot is c's, which can't sleep: a newcomer waits for it rather than putting a to sleep.
  let d: { id: number; vm: Vm } | undefined;
  void vms.hold("VM d").then((held) => (d = held));
  await new Promise((r) => setTimeout(r, 50));
  expect(d).toBeUndefined();
  expect(log).not.toContain(`suspend ${vms.slotOf(a)} ${a}`);
  await vms.give(c.id, false);
  await until(() => d !== undefined);
  expect(d!.vm.slot).toBe(c.vm.slot);
});

test("an overflow host is used only once the others' slots are taken", async () => {
  const vms = pool({ busy: () => true });
  await vms.addHost(await host([101], [], { overflow: true }));
  await vms.addHost(await host([1]));
  vms.run("silent").result.catch(() => {});
  vms.run("silent").result.catch(() => {});
  await until(() => vms.running().filter((t) => t.slot).length === 2);
  expect(vms.running().map((t) => t.slot)).toEqual([1, 101]);
  for (const t of vms.running()) vms.stop(t.id);
});

// The gate: each slot's listener, tell_task to a running or queued task, and the tool calls' stamps.
async function gated() {
  const gate = createGate({ llm: { url: "http://127.0.0.1:9", key: "k" }, models: {}, send: async () => {} });
  const servers = new Map<number, Server>();
  const listen = gate.listen;
  gate.listen = async (h, port, opts) => {
    const server = await listen(h, port, opts);
    servers.set(opts?.slot ?? 0, server as unknown as Server);
    return server;
  };
  const reports: string[] = [];
  const parents: (string | undefined)[] = [];
  const local = await host([1, 2], [], { gate: () => ({ host: "127.0.0.1", port: 0, peer: () => "127.0.0.1" }) });
  const { vms, tools } = await gateTasks(gate, local, (_goal, { report }, parent) => (reports.push(report), parents.push(parent)), file(), undefined, agent);
  const messages = (slot: number) => fetch(`http://127.0.0.1:${(servers.get(slot)!.address() as AddressInfo).port}/messages`, { headers: { host: "gate" } }).then((r) => r.json());
  const said = async (name: string, args: Record<string, unknown> = {}, caller?: Caller) => ((await localTools(tools).call(name, args, caller)).content[0] as { text: string }).text;
  return { gate, vms, said, messages, reports, parents, close: () => servers.forEach((s) => s.close()) };
}

test("tell_task passes the owner's message to that running task's VM, holds it for a queued one, and says when there's none", async () => {
  const { gate, vms, said, messages, reports, close } = await gated();
  gate.busy = () => ({ tool: "vault_fill", since: Date.now() });
  for (const goal of ["silent", "silent", "silent"]) await said("task", { goal });
  await until(() => vms.running().filter((t) => t.slot).length === 2);
  const second = vms.running().find((t) => t.id === 2)!.slot!;

  expect(await said("tell_task", { id: 2, message: "make it 4 people at 8" })).toBe("Told #2. Its report will say what it did.");
  expect(await messages(second)).toEqual(["make it 4 people at 8"]);
  expect(await said("tell_task", { id: 3, message: "Friday instead" })).toBe("#3 is still waiting for a VM; it gets the message when it starts.");
  expect(await said("tell_task", { id: 9, message: "never mind" })).toContain("No task #9 is running or still around");
  expect(await said("running_tasks")).toContain("#1 (0 min, in vault_fill for 0 min, likely waiting on the owner's yes): silent");
  vms.stop(1);
  await until(() => vms.running().find((t) => t.id === 3)?.slot !== undefined);
  expect(await messages(vms.running().find((t) => t.id === 3)!.slot!)).toEqual(["Friday instead"]);
  vms.stop(2);
  vms.stop(3);
  await until(() => reports.length === 3);
  expect(reports).toContain("The task failed: the task was stopped");
  close();
});

test("the gate stamps a task VM's tool calls with its task, and knows the slot is mid-call", async () => {
  const gate = createGate({ llm: { url: "http://127.0.0.1:9", key: "k" }, models: {}, send: async () => {} });
  const callers: Caller[] = [];
  let finish = () => {};
  gate.add({ ...localTools([]), tasks: localTools([{ name: "slow", description: "", input: { type: "object" }, run: async (_a, caller) => (callers.push(caller), await new Promise<void>((r) => (finish = r)), text("ok")) }]) });
  const server = await gate.listen("127.0.0.1", 0, { slot: 1 });
  gate.assign(1, 42);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));

  const call = client.callTool({ name: "slow", arguments: {} });
  await until(() => callers.length === 1);

  expect(callers[0]).toEqual({ slot: 1, task: 42 });
  expect(gate.busy(1)?.tool).toBe("slow");
  finish();
  await call;
  expect(gate.busy(1)).toBeUndefined();
  server.close();
});

test("a task started from a main session reports back to that session", async () => {
  const { said, reports, parents, close } = await gated();
  await said("task", { goal: "book it" }, { session: "7" });
  await until(() => reports.length === 1);
  expect([reports[0], parents[0]]).toEqual(["done: book it", "7"]);
  close();
});
