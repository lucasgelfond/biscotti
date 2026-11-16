import type { Db } from "@biscotti/core";
import { sql } from "drizzle-orm";
import { emit, taskEvents, type Alive, type Host, type Kept, type Running, type RunOptions, type Setup, type Sleep, type TaskResult, type TaskRun, type Vm, prepareVm, endpoints } from "./types.ts";
import type { Duplex } from "node:stream";

// Each task runs in a fresh VM restored from the snapshot, in a slot of a host (this machine's, or a plugin's machines),
// with one VM of this machine always restored ahead of time. A finished task's VM is deleted, unless the owner asked to
// keep it (`keep`, or asking for its live desktop): then it stays open, and goes to sleep (kept on disk) only when its
// slot is needed. Every day the main agent asks the owner which of the VMs still around can go.

const TASK_TIMEOUT_MS = 30 * 60_000;
// How many VMs to keep (each is about the VM's memory plus what it wrote), oldest deleted first.
const KEPT_MAX = Number(process.env.SUSPENDED_MAX ?? 6);
// The desktop's shape when a task doesn't say: TASK_DISPLAY=mobile for an owner who watches from their phone.
const DISPLAY = process.env.TASK_DISPLAY === "mobile" ? "mobile" : "desktop";
// How often open VMs are checked for someone on them.
const USE_CHECK_MS = Number(process.env.VM_USE_CHECK_MS ?? 5 * 60_000);
type Options = RunOptions & { followup?: boolean };

// The pool: the hosts' slots, the tasks and held VMs in them, and the kept VMs (in `db`, with the last number used,
// across restarts), each by its number. `run` runs a task in its slot's VM (the main agent, index.ts), until it reports
// or `stopped` (stopped, or out of time). `busy` says whether someone's working in a slot's VM (a tool call of its
// own). `onStart` and `onEnd` see each task and held VM take and leave its slot.
export function taskVms(
  hooks: {
    run(slot: number, task: TaskRun, opts: Options, stopped: AbortSignal): Promise<TaskResult>;
    busy?(slot: number): boolean;
    onStart?(slot: number, id: number, goal: string, model?: string): void;
    onReport?(slot: number, result: TaskResult): TaskResult;
    onEnd?(slot: number): void;
  },
  db?: Db,
) {
  const hostOf = new Map<number, Host>();
  const free: number[] = [];
  const waiting: { fits: (slot: number) => boolean; resolve: (slot: number) => void }[] = [];
  const rank = (slot: number) => (hostOf.get(slot)!.overflow ? 1e9 : 0) + slot;
  const whereSlot = (slot: number) => hostOf.get(slot)?.label ?? (hostOf.get(slot)?.overflow ? "cloud" : "local");

  db?.run(sql`CREATE TABLE IF NOT EXISTS kept_vms (id integer PRIMARY KEY, goal text NOT NULL, slot integer NOT NULL, at integer NOT NULL, pr text)`);
  db?.run(sql`CREATE TABLE IF NOT EXISTS task_numbers (last integer NOT NULL)`);
  const kept = (db?.all<Kept & { pr: string | null }>(sql`SELECT * FROM kept_vms ORDER BY at`) ?? []).map(({ pr, ...k }) => ({ ...k, ...(pr && { pr }) }));
  let last = db?.get<{ last: number }>(sql`SELECT last FROM task_numbers`)?.last ?? 0;
  const save = () =>
    db?.transaction((tx) => {
      tx.run(sql`DELETE FROM task_numbers`);
      tx.run(sql`INSERT INTO task_numbers (last) VALUES (${last})`);
      tx.run(sql`DELETE FROM kept_vms`);
      for (const k of kept) tx.run(sql`INSERT INTO kept_vms (id, goal, slot, at, pr) VALUES (${k.id}, ${k.goal}, ${k.slot}, ${k.at}, ${k.pr ?? null})`);
    });
  // Numbered before any await, so a task started right after is listed after this one.
  const reserve = () => ((last = Math.max(last, ...kept.map((k) => k.id)) + 1), save(), last);
  const running = new Map<number, Running & { stopped: AbortController }>();
  // VMs held after or outside a task, and when each was last used: a task's kept open (`open`), or a plugin's (hold).
  const held = new Map<number, { vm: Vm; goal: string; used: number; sleep?: Sleep; sleeping?: boolean; open?: boolean }>();
  // Tasks whose VM stays open once done; what each one's work became.
  const keepers = new Set<number>();
  // How each task was started, for its follow-ups (its `after`, its model, what it collects), until its VM is gone.
  const remembered = new Map<number, Options>();
  taskEvents.on("event", (e) => void (e.type === "done" && remembered.delete(e.id)));
  const prs = new Map<number, string>(kept.flatMap((k) => (k.pr ? [[k.id, k.pr] as const] : [])));
  setInterval(async () => {
    for (const h of held.values()) {
      if (hooks.busy?.(h.vm.slot) || (await Promise.resolve(hostOf.get(h.vm.slot)?.active?.(h.vm.slot)).catch(() => false))) h.used = Date.now();
    }
    // A newcomer still waiting because a VM couldn't be put to sleep for it (a full disk, say): another try.
    for (const w of waiting) makeRoom(w.fits);
  }, USE_CHECK_MS).unref();

  // The best free slot that fits (this machine's before overflow ones), or the first one released that does.
  const acquire = (fits: (slot: number) => boolean = () => true) =>
    new Promise<number>((resolve) => {
      free.sort((a, b) => rank(a) - rank(b));
      const i = free.findIndex(fits);
      if (i >= 0) resolve(free.splice(i, 1)[0]);
      else waiting.push({ fits, resolve }), makeRoom(fits);
    });
  // When every slot that fits is held by a VM that may sleep (an ssh VM), the one used longest ago goes to sleep (kept,
  // to open again) to make room. A slot with a task in it frees itself, so then the newcomer waits.
  function makeRoom(fits: (slot: number) => boolean) {
    const sleepers = [...held].filter(([, h]) => h.sleep && !h.sleeping && fits(h.vm.slot));
    const slots = [...hostOf.keys()].filter((s) => fits(s) && s !== warm?.slot);
    if (!sleepers.length || slots.some((s) => !sleepers.some(([, h]) => h.vm.slot === s))) return;
    const [id, oldest] = sleepers.sort(([a, x], [b, y]) => x.sleep!.used(a) - y.sleep!.used(b))[0];
    oldest.sleeping = true;
    oldest.sleep!.sleep(id).catch((err) => ((oldest.sleeping = false), console.error(`putting a VM to sleep: ${err.message}`)));
  }
  function release(slot: number) {
    hooks.onEnd?.(slot);
    const i = waiting.findIndex((w) => w.fits(slot));
    if (i >= 0) return waiting.splice(i, 1)[0].resolve(slot);
    free.push(slot);
    warmUp();
  }

  // One VM restored ahead of time, on a host that doesn't cost money to run.
  let warm: { slot: number; vm: Promise<Vm> } | undefined;
  function warmUp() {
    const i = free.findIndex((s) => !hostOf.get(s)!.overflow);
    if (warm || i < 0) return;
    const [slot] = free.splice(i, 1);
    warm = { slot, vm: hostOf.get(slot)!.restore(slot) };
    // On failure (e.g. no snapshot yet), try again in a while rather than at once.
    warm.vm.catch((err) => {
      console.error(`restoring a VM in slot ${slot}: ${err.message}`);
      warm = undefined;
      setTimeout(() => release(slot), 30_000);
    });
  }
  // A fresh VM in a slot that fits: the warm one if it does. Claimed before any await, so callers never share it.
  async function fresh(fits: (slot: number) => boolean = () => true) {
    if (!hostOf.size) throw new Error("no machine for task VMs here (the firecracker plugin adds this one's, external-vm-node EC2's)");
    const claimed = warm && fits(warm.slot) ? warm : undefined;
    if (claimed) warm = undefined;
    const ready = claimed && (await claimed.vm.catch(() => undefined));
    if (claimed && !ready) release(claimed.slot);
    let vm: Vm;
    if (ready) vm = ready;
    else {
      const slot = await acquire(fits);
      vm = await hostOf.get(slot)!.restore(slot).catch((err) => (release(slot), Promise.reject(err)));
    }
    warmUp();
    return vm;
  }
  // A kept VM back in its slot (the warm VM there, if there is one, is thrown away).
  async function bringBack(k: Kept) {
    const host = hostOf.get(k.slot);
    if (!host?.resume) throw new Error(`#${k.id}'s machine isn't here`);
    if (warm?.slot === k.slot) {
      const claimed = warm;
      warm = undefined;
      await (await claimed.vm.catch(() => undefined))?.stop().catch(() => {});
    } else await acquire((s) => s === k.slot);
    return host.resume(k.slot, k.id).catch((err) => (release(k.slot), Promise.reject(err)));
  }
  const takeKept = (id: number) => {
    const i = kept.findIndex((k) => k.id === id);
    if (i < 0) return undefined;
    const [k] = kept.splice(i, 1);
    save();
    return k;
  };

  // Keeps a VM that's done (suspended, for later) and frees its slot, or throws it away when it can't be kept. One that
  // couldn't be saved (a full disk, say) but is still running stays open rather than lose what's in it.
  async function putAway(vm: Vm, id: number, goal: string, keep = true) {
    if (keep && vm.suspend && hostOf.get(vm.slot)?.resume) {
      try {
        await vm.suspend(id);
        release(vm.slot);
        kept.push({ id, goal, slot: vm.slot, at: Date.now(), ...(prs.has(id) && { pr: prs.get(id) }) });
        emit({ id, type: "kept", slot: vm.slot, where: whereSlot(vm.slot) });
        for (const old of kept.splice(0, Math.max(0, kept.length - KEPT_MAX))) {
          await hostOf.get(old.slot)?.discard?.(old.slot, old.id).catch(() => {});
          emit({ id: old.id, type: "done", text: "Deleted (too many kept)" });
        }
        return void save();
      } catch (err) {
        console.error(`keeping #${id}: ${(err as Error).message}`);
        if ((err as { running?: boolean }).running) return keepOpen(vm, id, goal, "Couldn't be put to sleep, so it's still open");
      }
    }
    await vm.stop().catch(() => {});
    prs.delete(id);
    emit({ id, type: "done" });
    release(vm.slot);
  }

  // A done task's VM, open until it's deleted, or put to sleep when its slot is needed.
  const openSleep: Sleep = { used: (id) => held.get(id)?.used ?? 0, sleep: (id) => give(id) };
  function keepOpen(vm: Vm, id: number, goal: string, text = "Kept open") {
    held.set(id, { vm, goal, used: Date.now(), open: true, sleep: openSleep });
    emit({ id, type: "started", slot: vm.slot, where: whereSlot(vm.slot), text });
  }
  async function give(id: number, keep = true) {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    await putAway(h.vm, id, h.goal, keep);
  }

  // A task in `vm` (or a fresh one), reported as it goes.
  async function task(id: number, goal: string, said: string, opts: Options, vm?: () => Promise<Vm>): Promise<TaskResult> {
    const entry = { id, goal, started: Date.now(), stopped: new AbortController() };
    running.set(id, entry);
    try {
      const v = await (vm ? vm() : fresh(opts.fits));
      try {
        entry.stopped.signal.throwIfAborted();
        Object.assign(entry, { slot: v.slot });
        emit({ id, type: opts.followup ? "resumed" : "started", slot: v.slot, where: whereSlot(v.slot), ...(opts.followup && { text: said }) });
        hooks.onStart?.(v.slot, id, said, opts.model);
        const { runner, model, display = DISPLAY, followup, instructions, check, collect, timeoutMs = TASK_TIMEOUT_MS } = opts;
        const limit = setTimeout(() => entry.stopped.abort(new Error(`the task ran out of time (${timeoutMs / 60_000} minutes)`)), timeoutMs);
        const ran = await hooks
          .run(v.slot, { id, goal: said, followup, model, display, runner, instructions, check, collect }, opts, entry.stopped.signal)
          .finally(() => clearTimeout(limit));
        const reported = hooks.onReport?.(v.slot, ran) ?? ran;
        const result = opts.after ? await opts.after(reported) : reported;
        emit({ id, type: "report", text: result.report });
        return result;
      } finally {
        if (keepers.has(id)) keepOpen(v, id, goal);
        else await putAway(v, id, goal, false);
      }
    } catch (err) {
      emit({ id, type: "failed", text: (err as Error).message });
      throw err;
    } finally {
      running.delete(id);
    }
  }

  const slotOf = (id: number) => running.get(id)?.slot ?? held.get(id)?.vm.slot;
  // A running task's or held VM's slot and host, for asking its host.
  const at = (id: number) => {
    const slot = slotOf(id);
    if (slot === undefined) throw new Error(`no VM #${id} is running`);
    return { slot, host: hostOf.get(slot)! };
  };
  return {
    async addHost(host: Host) {
      for (const slot of host.slots) {
        hostOf.set(slot, host);
        endpoints.set(slot, (port) => host.endpoint(slot, port));
        release(slot);
      }
    },
    slotOf,
    host: (slot: number) => hostOf.get(slot),
    reserve,
    launch(goal: string, opts: Options = {}) {
      const id = opts.id ?? reserve();
      if (opts.keep) keepers.add(id);
      remembered.set(id, opts);
      emit({ id, type: "queued", goal, kind: "sandbox", ...(opts.parent && { parent: opts.parent }) });
      return { id, result: task(id, goal, goal, opts) };
    },
    // A kept task's VM back in its slot, given the owner's message; false when there's no such task. Its report
    // comes back like a run's, and it's kept again afterwards.
    resume(id: number, message: string) {
      if (running.has(id)) return false;
      const { id: _, keep, fits, ...opts } = remembered.get(id) ?? {};
      const h = held.get(id);
      if (h?.open) {
        held.delete(id);
        return task(id, `${h.goal}\n(Follow-up) ${message}`, message, { ...opts, followup: true }, async () => h.vm);
      }
      const k = takeKept(id);
      if (!k) return false;
      return task(id, `${k.goal}\n(Follow-up) ${message}`, message, { ...opts, followup: true }, () => bringBack(k));
    },
    stop(id: number) {
      const entry = running.get(id);
      entry?.stopped.abort(new Error("the task was stopped"));
      return !!entry;
    },
    running: (): Running[] => [...running.values()].map(({ stopped, ...t }) => t),
    kept: (): Kept[] => [...kept],
    where: (id: number) => {
      const slot = slotOf(id);
      return slot === undefined ? undefined : whereSlot(slot);
    },
    labels: () => [...new Set([...hostOf.keys()].map(whereSlot))],
    // The VM set up, by its host (Host.prepare) or else by the VM image's own setup.
    prepare(id: number, setup: Setup) {
      const { slot, host } = at(id);
      return host.prepare ? host.prepare(slot, setup) : prepareVm(host.endpoint(slot, 4000), setup);
    },
    async watch(id: number) {
      const slot = slotOf(id);
      return slot === undefined ? undefined : await hostOf.get(slot)?.watch?.(slot);
    },
    async site(id: number) {
      const slot = slotOf(id);
      return slot === undefined ? undefined : await hostOf.get(slot)?.site?.(slot);
    },
    // Where the owner reaches the VM's sshd: its host's address for that, or its endpoint for port 22.
    ssh(id: number) {
      const { slot, host } = at(id);
      return host.ssh?.(slot) ?? host.endpoint(slot, 22);
    },
    // pi-env's daemon in the VM: by its host, or over ssh to its port 22 (`pipe`, vm-env.ts).
    env(id: number, args: string[], socket: Duplex, pipe: (at: { host: string; port: number }) => Promise<void>) {
      const { slot, host } = at(id);
      return host.env ? host.env(slot, args, socket) : pipe(host.endpoint(slot, 22));
    },
    async hold(goal: string, opts: { model?: string; where?: string; fits?: (slot: number) => boolean; sleep?: Sleep } = {}) {
      const id = reserve();
      const vm = await fresh(opts.where ? (slot) => whereSlot(slot) === opts.where && (opts.fits?.(slot) ?? true) : opts.fits);
      held.set(id, { vm, goal, used: Date.now(), sleep: opts.sleep });
      hooks.onStart?.(vm.slot, id, goal, opts.model);
      return { id, vm };
    },
    give: (id: number) => give(id),
    drop: (id: number) => give(id, false),
    async reclaim(id: number, opts: { model?: string; sleep?: Sleep } = {}) {
      // One kept open (e.g. woken for its live desktop) is handed over as it is.
      const h = held.get(id);
      if (h?.open) return Object.assign(h, { open: false, sleep: opts.sleep, used: Date.now() }).vm;
      const k = takeKept(id);
      if (!k) return undefined;
      const vm = await bringBack(k);
      held.set(id, { vm, goal: k.goal, used: Date.now(), sleep: opts.sleep });
      hooks.onStart?.(vm.slot, id, k.goal, opts.model);
      return vm;
    },
    async keep(id: number) {
      if (running.has(id)) return (keepers.add(id), true);
      if (held.has(id)) return true;
      const k = takeKept(id);
      if (!k) return false;
      keepers.add(id);
      keepOpen(await bringBack(k), id, k.goal);
      return true;
    },
    alive: (): Alive[] => [
      ...[...held].map(([id, h]) => ({ id, goal: h.goal, asleep: false, used: h.used, ...(prs.has(id) && { pr: prs.get(id) }) })),
      ...kept.map((k) => ({ id: k.id, goal: k.goal, asleep: true, used: k.at, ...(k.pr && { pr: k.pr }) })),
    ],
    // Deleted for good, whatever it's doing: a running task's once it's done, a held one now (its plugin hears
    // "done"), an asleep one's files.
    async remove(id: number) {
      keepers.delete(id);
      if (running.has(id)) return true;
      if (held.has(id)) return (await give(id, false), true);
      const k = takeKept(id);
      if (!k) return false;
      await hostOf.get(k.slot)?.discard?.(k.slot, k.id).catch(() => {});
      prs.delete(id);
      emit({ id, type: "done", text: "Deleted" });
      return true;
    },
    note(id: number, note: { pr?: string }) {
      if (!note.pr) return;
      prs.set(id, note.pr);
      const k = kept.find((k) => k.id === id);
      if (k) (k.pr = note.pr), save();
    },
  };
}

