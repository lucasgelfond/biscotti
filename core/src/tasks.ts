import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { createGate } from "./gate.ts";
import { call } from "./http.ts";
import { input, str, text, type LocalTool, type TaskOptions, type TaskResult } from "./plugin.ts";

// Each task runs in a fresh VM restored from the snapshot, in one of three slots (network namespaces), with one always
// restored ahead of time.

const TASK_TIMEOUT_MS = 30 * 60_000;
// A task that goes quiet this long is stuck, whatever its time limit.
const IDLE_MS = 10 * 60_000;
// The events, the screenshot and a coding task's commits, base64.
const MAX_OUTPUT = 100 * 1024 * 1024;
export const SLOTS = [1, 2, 3];

export interface Vm {
  slot: number;
  stop(): Promise<void>;
}

// VMs from the vms service, over its socket.
export const vmService = (socketPath: string) => async (slot: number): Promise<Vm> => {
  await call(socketPath, "POST", `/vms/${slot}`);
  return { slot, stop: async () => void (await call(socketPath, "DELETE", `/vms/${slot}`)) };
};

export function taskVms(restore: (slot: number) => Promise<Vm>) {
  const free = [...SLOTS];
  const waiting: ((slot: number) => void)[] = [];
  const acquire = () => new Promise<number>((resolve) => (free.length ? resolve(free.shift()!) : waiting.push(resolve)));
  let warm: Promise<Vm> | undefined;

  function release(slot: number) {
    if (waiting.length) return waiting.shift()!(slot);
    free.push(slot);
    warmUp();
  }

  function warmUp() {
    if (warm || !free.length) return;
    const slot = free.shift()!;
    warm = restore(slot);
    // On failure (e.g. no snapshot yet), try again in a while rather than at once.
    warm.catch((err) => {
      console.error(`restoring a VM in slot ${slot}: ${err.message}`);
      warm = undefined;
      setTimeout(() => release(slot), 30_000);
    });
  }

  async function take() {
    // Claimed before any await, so tasks starting together never share it.
    const claimed = warm;
    warm = undefined;
    const ready = claimed && (await claimed.catch(() => undefined));
    return ready ?? restore(await acquire());
  }

  async function run(goal: string, onStart?: (slot: number) => void, opts: TaskOptions = {}): Promise<TaskResult> {
    const vm = await take();
    warmUp();
    try {
      onStart?.(vm.slot);
      return await runPi(`10.200.${vm.slot}.2`, goal, opts);
    } finally {
      await vm.stop();
      release(vm.slot);
    }
  }

  warmUp();
  return { run };
}

// Firecracker in the slot's namespace, as the slot's own user (`uid`) with no capabilities, like Firecracker's jailer.
export async function restore(vmDir: string, firecracker: string, slot: number, uid: number): Promise<Vm> {
  const sock = `/tmp/fc-${slot}.sock`;
  rmSync(sock, { force: true });
  const as = ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, `--groups=${statSync("/dev/kvm").gid}`, "--inh-caps=-all", "--no-new-privs", "--"];
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
      pager = spawn(as[0], [...as.slice(1), handler, uffd, `${vmDir}/desktop.mem`], { stdio: "ignore", env: { PATH: process.env.PATH } });
      while (!existsSync(uffd)) await new Promise((r) => setTimeout(r, 5));
    }
    await call(sock, "PUT", "/snapshot/load", JSON.stringify({
      snapshot_path: `${vmDir}/desktop.snap`,
      mem_backend: handler ? { backend_type: "Uffd", backend_path: uffd } : { backend_type: "File", backend_path: `${vmDir}/desktop.mem` },
      resume_vm: true,
    }));
    return { slot, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}


// The goal (and a repo, as a git bundle) goes to pi in the VM, or to a plugin's own runner; its last assistant text is
// the report, then a screenshot and the repo's new commits follow.
function runPi(host: string, goal: string, { repo, runner, timeoutMs = TASK_TIMEOUT_MS }: TaskOptions) {
  return new Promise<TaskResult>((resolve, reject) => {
    const socket = connect({ host, port: 4000 }, () => socket.end(JSON.stringify({ goal, repo: repo?.toString("base64"), runner })));
    socket.setTimeout(Math.min(IDLE_MS, timeoutMs), () => socket.destroy(new Error("the task went quiet")));
    const limit = setTimeout(() => socket.destroy(new Error(`the task ran out of time (${timeoutMs / 60_000} minutes)`)), timeoutMs);
    let received = 0;
    socket.on("data", (d: Buffer) => (received += d.length) > MAX_OUTPUT && socket.destroy(new Error("the task sent too much back")));
    let report = "";
    let screenshot: Buffer | undefined;
    let bundle: Buffer | undefined;
    // The socket's errors end the task (below); unhandled here, they'd take the gate down.
    createInterface({ input: socket }).on("error", () => {}).on("line", (line) => {
      let event: { type: string; png?: string; data?: string; message?: { role: string; content: { type: string; text?: string }[] } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "screenshot") screenshot = Buffer.from(event.png!, "base64");
      if (event.type === "bundle") bundle = Buffer.from(event.data!, "base64");
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const text = event.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
      if (text) report = text;
    });
    socket.on("error", reject).on("close", () => {
      clearTimeout(limit);
      resolve({ report: report || "The task ended without a report.", screenshot, bundle });
    });
  });
}

export function taskTool(vms: ReturnType<typeof taskVms>, onReport: (goal: string, result: TaskResult) => void, watch?: (slot: number) => string): LocalTool {
  return {
    name: "task",
    description:
      "Start a task in a fresh, disposable Linux VM with a desktop, browser, shell and internet, for anything that needs a website, a program or files. Returns right away; the report arrives later as a message starting 'Task report'. The task agent sees only the goal, so make it complete.",
    input: input({ goal: str() }),
    async run(args) {
      const goal = String(args.goal);
      const running = new Promise<number>((resolve) =>
        vms.run(goal, resolve).then(
          (result) => onReport(goal, result),
          (err) => onReport(goal, { report: `The task failed: ${err.message}` }),
        ),
      );
      // A queued task (every slot busy) doesn't hold up the reply.
      const slot = watch && (await Promise.race([running, new Promise<undefined>((r) => setTimeout(r, 3000))]));
      return text(slot ? `Task started. Its live desktop, only for a user who asks to watch or take over: ${watch(slot)}` : "Task started.");
    },
  };
}

// Task VMs for the gate, from the vms service at `socket`: each slot's listener on its link, the `task` plugins get
// (with a coding task's model routed to its slot), and the task tool, whose reports go to `report`.
export async function gateTasks(gate: ReturnType<typeof createGate>, socket: string, vmDir: string, report: (goal: string, result: TaskResult) => void) {
  for (const slot of SLOTS) await gate.listen(`10.200.${slot}.1`, 80, { slot, peer: `10.200.${slot}.2` });
  const vms = taskVms(vmService(socket));
  // The live desktop's password goes in the link's fragment, which the browser never sends to the server.
  const host = process.env.TAILNET_HOST;
  const password = () => (existsSync(`${vmDir}/vnc-password`) ? readFileSync(`${vmDir}/vnc-password`, "utf8").trim() : "");
  const watch = host ? (slot: number) => `https://${host}:${10440 + slot}/vnc.html#autoconnect=1&password=${password()}` : undefined;
  return {
    async task(goal: string, { model, ...opts }: TaskOptions = {}) {
      let slot: number | undefined;
      try {
        return await vms.run(goal, (s) => ((slot = s), model && gate.route(s, model)), opts);
      } finally {
        if (slot) gate.route(slot);
      }
    },
    tool: taskTool(vms, report, watch),
  };
}
