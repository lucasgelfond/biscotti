import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { createGate } from "./gate.ts";
import { REMOTE_BASE, vmEndpoint } from "./plugin.ts";
import { taskEvents, type TaskEvent, type taskVms, type Vm, where } from "./tasks.ts";

// Boxes: a task VM the owner works in over ssh with their own pi, rather than one run of the task agent. Kept
// (suspended) when closed. BOX_WARM_REPO / BOX_WARM_COUNT / BOX_WARM_SETUP keep warm ones checked out and set up.

export interface Box {
  id: number;
  slot: number;
  repo?: string;
  where: "local" | "cloud";
  ssh: { host: string; port: number; user: string };
  preview?: string;
  opened: number;
}

export interface BoxRequest {
  repo?: string;
  base?: string;
  key: string;
  setup?: string;
}

type Pool = ReturnType<typeof taskVms>;
type Bundle = (repo: string, base?: string) => Promise<Buffer>;

// Local slots via `tailscale serve` on 2200 + slot (nix/setup.nix); remote ones via the node's forwards.
export function sshEndpoint(slot: number) {
  if (slot > REMOTE_BASE) return { ...vmEndpoint(slot, 22), user: "cua" };
  return { host: process.env.TAILNET_HOST ?? `10.200.${slot}.2`, port: process.env.TAILNET_HOST ? 2200 + slot : 22, user: "cua" };
}

const SETUP_TIMEOUT_MS = 30 * 60_000;
const details = (box: Box) => ({ kind: "box" as const, repo: box.repo, ssh: box.ssh, preview: box.preview });
const emit = (event: Omit<TaskEvent, "at">) => taskEvents.emit("event", { ...event, at: Date.now() });

function prepare(vm: Vm, message: { key?: string; repo?: Buffer; setup?: string }, onLine?: (line: string) => void) {
  const { host, port } = vm.address ?? vmEndpoint(vm.slot, 4000);
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port }, () =>
      socket.end(JSON.stringify({ box: { key: message.key, repo: message.repo?.toString("base64"), setup: message.setup } })),
    );
    const timer = setTimeout(() => socket.destroy(new Error("the box's setup took too long")), SETUP_TIMEOUT_MS);
    let done = false;
    createInterface({ input: socket, crlfDelay: Infinity })
      .on("error", () => {})
      .on("line", (line) => {
        let event: { type?: string; ok?: boolean; error?: string; line?: string };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "setup" && event.line) onLine?.(event.line);
        if (event.type === "box") {
          done = true;
          clearTimeout(timer);
          if (event.ok) resolve();
          else reject(new Error(event.error ?? "the box couldn't be set up"));
        }
      });
    socket.on("error", (err) => (clearTimeout(timer), reject(err)));
    socket.on("close", () => (clearTimeout(timer), done || reject(new Error("the box's VM closed the connection"))));
  });
}

export function boxes(
  pool: Pool,
  gate: ReturnType<typeof createGate>,
  opts: { bundle: () => Bundle | undefined; watch?: (slot: number) => string | Promise<string> },
) {
  const open = new Map<number, { box: Box; vm: Vm; goal: string }>();
  const warmRepo = process.env.BOX_WARM_REPO;
  const warmCount = warmRepo ? Number(process.env.BOX_WARM_COUNT ?? 1) : 0;
  const warmSetup = process.env.BOX_WARM_SETUP || undefined;
  const ready: { vm: Vm; id: number }[] = [];
  let warming = 0;

  const claim = (vm: Vm, id: number, goal: string) => (gate.assign(vm.slot, id, goal), gate.route(vm.slot, "code"));
  const unclaim = (slot: number) => (gate.assign(slot), gate.route(slot));

  async function checkout(repo: string, base?: string) {
    const bundle = opts.bundle();
    if (!bundle) throw new Error("GitHub isn't connected, so biscotti can't check the repo out (github_connect)");
    return bundle(repo, base);
  }

  async function describe(id: number, vm: Vm, repo?: string): Promise<Box> {
    return {
      id,
      slot: vm.slot,
      repo,
      where: where(vm.slot),
      ssh: sshEndpoint(vm.slot),
      preview: opts.watch ? await Promise.resolve(opts.watch(vm.slot)).catch(() => undefined) : undefined,
      opened: Date.now(),
    };
  }

  async function warmUp() {
    while (ready.length + warming < warmCount) {
      warming++;
      void (async () => {
        let vm: Vm | undefined;
        const id = pool.nextId();
        try {
          vm = await pool.hold();
          claim(vm, id, `box ${warmRepo}`);
          await prepare(vm, { repo: await checkout(warmRepo!), setup: warmSetup });
          ready.push({ vm, id });
        } catch (err) {
          console.error(`warming a box of ${warmRepo}: ${(err as Error).message}`);
          if (vm) (unclaim(vm.slot), await pool.drop(vm).catch(() => {}));
          await new Promise((r) => setTimeout(r, 5 * 60_000));
        } finally {
          warming--;
        }
        void warmUp();
      })();
    }
  }

  return {
    async open(request: BoxRequest): Promise<Box> {
      if (!/^(ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+( .*)?$/.test(request.key.trim())) throw new Error("that isn't an ssh public key");
      const goal = `Box${request.repo ? ` on ${request.repo}` : ""}`;
      const warm = request.repo && request.repo === warmRepo && !request.base && !request.setup ? ready.shift() : undefined;
      if (warm) {
        void warmUp();
        await prepare(warm.vm, { key: request.key });
        const box = await describe(warm.id, warm.vm, request.repo);
        open.set(warm.id, { box, vm: warm.vm, goal });
        emit({ id: warm.id, type: "started", goal, slot: warm.vm.slot, where: box.where, ...details(box), text: "Opened (warm)" });
        return box;
      }
      const id = pool.nextId();
      emit({ id, type: "queued", goal, kind: "box", repo: request.repo });
      const repo = request.repo ? await checkout(request.repo, request.base) : undefined;
      const vm = await pool.hold();
      try {
        claim(vm, id, goal);
        emit({ id, type: "started", goal, slot: vm.slot, where: where(vm.slot), text: "Setting up" });
        await prepare(vm, { key: request.key, repo, setup: request.setup }, (line) => emit({ id, type: "step", tool: "setup", text: line.slice(0, 300) }));
      } catch (err) {
        unclaim(vm.slot);
        await pool.drop(vm).catch(() => {});
        emit({ id, type: "failed", text: (err as Error).message });
        throw err;
      }
      const box = await describe(id, vm, request.repo);
      open.set(id, { box, vm, goal });
      emit({ id, type: "step", ...details(box), text: "Ready" });
      return box;
    },

    async close(id: number) {
      const held = open.get(id);
      if (!held) return false;
      open.delete(id);
      unclaim(held.vm.slot);
      await pool.give(held.vm, { id, goal: held.goal });
      return true;
    },

    async reopen(id: number, key: string): Promise<Box | undefined> {
      if (open.has(id)) return open.get(id)!.box;
      const goal = pool.suspended().find((t) => t.id === id)?.goal ?? `Box #${id}`;
      const vm = await pool.reclaim(id);
      if (!vm) return undefined;
      claim(vm, id, goal);
      await prepare(vm, { key });
      const box = await describe(id, vm, /^Box on (.+)$/.exec(goal)?.[1]);
      open.set(id, { box, vm, goal });
      emit({ id, type: "resumed", slot: vm.slot, where: box.where, ...details(box), text: "Reopened" });
      return box;
    },

    list: (): Box[] => [...open.values()].map((h) => h.box),
    warmUp,
  };
}
