import { defineTool } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Type } from "typebox";

// Task VMs: each task gets a fresh desktop VM restored from the snapshot (core/vm/snapshots.sh) in a free slot, runs one
// pi task in it, and throws it away. Slots are network namespaces (installers/toolchain/net.nix) in which every VM
// looks the same, so up to three run at once; further tasks wait for a slot. One VM is always restored ahead of time,
// so a task starts without waiting on a restore.

const TASK_TIMEOUT_MS = 30 * 60_000;
export const SLOTS = [1, 2, 3];

interface Vm {
  slot: number;
  stop(): Promise<void>;
}

export interface TaskResult {
  report: string;
  // The VM's final screen, as PNG.
  screenshot?: Buffer;
}

export function taskVms(vmDir: string, firecracker: string) {
  const free = [...SLOTS];
  const waiting: ((slot: number) => void)[] = [];
  const acquire = () => new Promise<number>((resolve) => (free.length ? resolve(free.shift()!) : waiting.push(resolve)));
  let warm: Promise<Vm> | undefined;

  function release(slot: number) {
    if (waiting.length) return waiting.shift()!(slot);
    free.push(slot);
    warmUp();
  }

  // Restores a VM in a free slot, unless one is already waiting.
  function warmUp() {
    if (warm || !free.length) return;
    const slot = free.shift()!;
    warm = restore(vmDir, firecracker, slot);
    warm.catch((err) => {
      console.error(`restoring a VM in slot ${slot}: ${err.message}`);
      warm = undefined;
      release(slot);
    });
  }

  async function take() {
    const ready = warm && (await warm.catch(() => undefined));
    warm = undefined;
    return ready ?? restore(vmDir, firecracker, await acquire());
  }

  // `onStart` hears which slot the task got, e.g. to share its live desktop.
  async function run(goal: string, onStart?: (slot: number) => void): Promise<TaskResult> {
    const vm = await take();
    warmUp();
    try {
      onStart?.(vm.slot);
      return await runPi(`10.200.${vm.slot}.2`, goal);
    } finally {
      await vm.stop();
      release(vm.slot);
    }
  }

  // The snapshot's memory, read once so restores and first tasks don't wait on the disk.
  createReadStream(`${vmDir}/desktop.mem`).on("error", () => {}).resume();
  warmUp();
  return { run };
}

async function restore(vmDir: string, firecracker: string, slot: number): Promise<Vm> {
  const sock = `/tmp/fc-${slot}.sock`;
  rmSync(sock, { force: true });
  const vm = spawn("nsenter", [`--net=/run/netns/fc${slot}`, firecracker, "--api-sock", sock], { stdio: "ignore" });
  // Wait for the exit too: the next VM in this slot can't open the tap until this one has let go of it.
  const stop = async () => {
    const exited = once(vm, "exit");
    vm.kill("SIGKILL");
    await exited;
  };
  try {
    while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 20));
    await api(sock, "PUT", "/snapshot/load", {
      snapshot_path: `${vmDir}/desktop.snap`,
      mem_backend: { backend_type: "File", backend_path: `${vmDir}/desktop.mem` },
      resume_vm: true,
    });
    return { slot, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function api(socketPath: string, method: string, path: string, body: object) {
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d)).on("end", () => {
        if (res.statusCode! < 300) resolve();
        else reject(new Error(`firecracker ${path}: ${res.statusCode} ${text}`));
      });
    });
    req.on("error", reject).end(JSON.stringify(body));
  });
}

// Sends the goal to the VM's task listener and reads pi's JSON events: the last assistant text is the report, and a
// final screenshot line follows pi's output.
function runPi(host: string, goal: string) {
  return new Promise<TaskResult>((resolve, reject) => {
    const socket = connect({ host, port: 4000 }, () => socket.end(goal));
    socket.setTimeout(TASK_TIMEOUT_MS, () => socket.destroy(new Error("task timed out")));
    let report = "";
    let screenshot: Buffer | undefined;
    createInterface({ input: socket }).on("line", (line) => {
      const event = JSON.parse(line) as {
        type: string;
        png?: string;
        message?: { role: string; content: { type: string; text?: string }[] };
      };
      if (event.type === "screenshot") screenshot = Buffer.from(event.png!, "base64");
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const text = event.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
      if (text) report = text;
    });
    socket.on("error", reject).on("close", () => resolve({ report: report || "The task ended without a report.", screenshot }));
  });
}

// Starts a task and returns right away; `onReport` gets the report when the task ends.
export function taskTool(vms: ReturnType<typeof taskVms>, onReport: (goal: string, result: TaskResult) => void, onStart?: (slot: number) => void) {
  return defineTool({
    name: "task",
    label: "Task",
    description:
      "Start a task in a fresh, disposable Linux VM with a desktop, browser, shell and internet, for anything that needs a website, a program or files. Returns right away; the report arrives later as a message starting 'Task report'. The task agent sees only the goal, so make it complete.",
    parameters: Type.Object({ goal: Type.String() }),
    async execute(_id, { goal }) {
      vms.run(goal, onStart).then(
        (result) => onReport(goal, result),
        (err) => onReport(goal, { report: `The task failed: ${err.message}` }),
      );
      return { content: [{ type: "text" as const, text: "Task started." }], details: {} };
    },
  });
}
