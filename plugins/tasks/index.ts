import { appMethod, type Context, localTools, type Plugin } from "@biscotti/core";
import { board } from "./board.ts";
import { taskVms } from "./pool.ts";
import { taskTools } from "./tools.ts";
import { emit, type TaskResult, type Vms } from "./types.ts";
import { vmEnv } from "./vm-env.ts";

export * from "./types.ts";

// Tasks in VMs: the main agent's task tools, the pool of VMs on the machines plugins add (firecracker,
// external-vm-node), and the board the owner's apps show them on. Each task runs in a fresh VM, a conversation of the
// main agent's (agent.ts, this plugin's side there) whose tools work in that VM; the gate sets the VM up for it
// (pi-env over ssh, with a key of its own: vm-env.ts) and reaches it through the slot's listener, so it knows which
// task each slot runs (stamping its tool calls, routing its model) and appends what it proposed to its report. Reports
// of tasks started for the main agent go to the session that started them (their follow-ups' too).

// A task that goes quiet this long is stuck, whatever its time limit, unless it's in a tool call (e.g. one waiting on
// the owner's yes, which has a time limit of its own). The agent's side watches for it.
const IDLE_MS = Number(process.env.TASK_IDLE_MS ?? 10 * 60_000);

// The task VMs of a gate (its context): made once, by whichever plugin asks first.
const made = new WeakMap<Context, ReturnType<typeof create>>();
const of = (ctx: Context) => made.get(ctx) ?? made.set(ctx, create(ctx)).get(ctx)!;
export const vms = (ctx: Context): Vms => of(ctx).vms;

// Plugins' additions to a task's instructions, from its goal (the lessons plugin's, for the sites it names).
const instructors = new WeakMap<Context, ((goal: string) => string | undefined)[]>();
export const instruct = (ctx: Context, fn: (goal: string) => string | undefined) => void instructors.set(ctx, [...(instructors.get(ctx) ?? []), fn]);

function create(ctx: Context) {
  const { gate, agent } = ctx;
  const pipes = vmEnv(ctx.dir);
  // Messages for tasks still waiting for a VM, which their run starts with; where each task's reports go.
  const waiting = new Map<number, string[]>();
  const parents = new Map<number, string>();
  const pool = taskVms(
    {
      // Set up for pi-env (the gate's key authorized, a coding task's repo checked out, its host key trusted), then
      // run by the agent, the owner's messages so far with it.
      async run(_slot, task, opts, stopped) {
        const hostKey = await pool.prepare(task.id, { key: pipes.publicKey(), repo: task.followup ? undefined : opts.repo });
        if (hostKey) await pipes.trust(task.id, hostKey);
        stopped.throwIfAborted();
        const told = waiting.get(task.id);
        waiting.delete(task.id);
        const added = task.followup ? [] : (instructors.get(ctx) ?? []).flatMap((f) => f(task.goal) ?? []);
        const instructions = [task.instructions, ...added].filter(Boolean).join("\n\n") || undefined;
        const ran = await agent.request<{ report: string; screenshot?: string; collected?: string }>("tasks/run", { ...task, instructions, idleMs: IDLE_MS, ...(told && { told }) }, stopped);
        const bytes = (b64?: string) => (b64 ? Buffer.from(b64, "base64") : undefined);
        return { report: ran.report, screenshot: bytes(ran.screenshot), collected: bytes(ran.collected) };
      },
      // Someone's working in it (a gate tool call of its own): not idle.
      busy: (slot) => !!gate.busy(slot),
      onStart(slot, id, goal, model) {
        gate.assign(slot, id, goal);
        gate.route(slot, model);
        gate.proposed(slot);
      },
      onReport(slot, result) {
        const proposed = gate.proposed(slot);
        return proposed.length ? { ...result, report: `${result.report}\n\nThe task proposes, for you to decide:\n${proposed.map((p) => `- ${p}`).join("\n")}` } : result;
      },
      onEnd: (slot) => (gate.assign(slot), gate.route(slot)),
    },
    ctx.db,
  );
  const report = (goal: string, parent?: string) => (r: Promise<TaskResult>) =>
    r.then(
      ({ report, screenshot }) => ctx.deliver(`Task report (${goal}):\n${report}`, screenshot, parent),
      (err: Error) => ctx.deliver(`Task report (${goal}):\nThe task failed: ${err.message}`, undefined, parent),
    );

  const { launch, slotOf, env, ...rest } = pool;
  const vms: Vms = {
    ...rest,
    run: (goal, opts) => launch(goal, opts).result,
    start(goal, opts) {
      const { id, result } = launch(goal, opts);
      if (opts?.parent) parents.set(id, opts.parent);
      void report(goal, opts?.parent)(result);
      return id;
    },
    tell(id, message) {
      const task = pool.running().find((t) => t.id === id);
      if (task?.slot !== undefined) return (void agent.request("tasks/steer", { id, message: gate.tell(task.slot, message) }).catch((err: Error) => console.error(`telling #${id}: ${err.message}`)), "told");
      if (task) return (waiting.set(id, [...(waiting.get(id) ?? []), message]), "queued");
      const goal = pool.alive().find((v) => v.id === id)?.goal;
      const resumed = goal !== undefined && pool.resume(id, message);
      if (!resumed) return "none";
      void report(goal, parents.get(id))(resumed);
      return "resumed";
    },
    async addHost(added) {
      for (const slot of added.slots) {
        const at = added.gate(slot);
        await gate.listen(at.host, at.port, { slot, peer: at.peer });
      }
      await pool.addHost(added);
    },
  };
  // The main agent's calls for a task are its VM's (the gate's `?task=`).
  gate.locate((task) => slotOf(task));
  // pi-env's daemon in a running task's VM, for the agent's side (env-pipe.ts): by the VM's host, or over ssh.
  agent.upgrade("/env/", (req, socket) => {
    const id = Number(new URL(req.url ?? "/", "http://gate").pathname.match(/^\/env\/(\d+)$/)?.[1]);
    if (!id) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const args = String(req.headers["pi-env-arguments"] ?? "").split(" ").filter(Boolean);
    env(id, args, socket, (at) => pipes.pipe(id, at, args, socket)).catch((err: Error) => socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`));
  });

  // The board, for the agent's side to show as chats: every row each time it's ready, then each change. Its chats'
  // messages, stops and deletes come back here.
  const rows = board(ctx.db, vms);
  agent.onReady(() => {
    for (const row of rows.rows.values()) agent.notify("tasks/row", rows.summary(row));
  });
  rows.on((row) => agent.notify("tasks/row", rows.summary(row)));
  agent.handle("tasks/tell", ({ id, message }: { id: number; message: string }) => ({ told: vms.tell(id, message) }));
  agent.handle("tasks/stop", ({ id }: { id: number }) => ({ stopped: vms.stop(id) }));
  agent.handle("tasks/remove", async ({ id }: { id: number }) => {
    const removed = await vms.remove(id);
    emit({ id, type: "deleted" });
    return { removed };
  });
  // The apps' look at a task's or VM's live desktop, which keeps it open.
  appMethod("watch", async ({ id }) => (await vms.keep(Number(id)), { url: (await vms.watch(Number(id))) ?? null }));

  const doing = (slot: number) => {
    const call = gate.busy(slot);
    return call && `in ${call.tool} for ${Math.round((Date.now() - call.since) / 60_000)} min${call.tool === "vault_fill" ? ", likely waiting on the owner's yes" : ""}`;
  };
  return { vms, tools: taskTools(vms, doing) };
}

export default {
  agent: new URL("./agent.ts", import.meta.url).href,
  tools: async (ctx) => localTools(of(ctx).tools),
} satisfies Plugin;
