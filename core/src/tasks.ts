import { defineTool } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Type } from "typebox";

// Each task runs in a fresh VM restored from the snapshot, in one of three slots (network namespaces), or, where
// Firecracker is slow or missing (a Mac's Lima VM, a VPS without KVM), in a fresh container of the same desktop image.
// One is always started ahead of time.

const TASK_TIMEOUT_MS = 30 * 60_000;
export const SLOTS = [1, 2, 3];

interface Vm {
  slot: number;
  stop(): Promise<void>;
}

export interface TaskResult {
  report: string;
  screenshot?: Buffer;
}

// Firecracker VMs, restored from the snapshot in vmDir.
export function firecrackerVms(vmDir: string, firecracker: string) {
  // Pull the snapshot's memory into the page cache.
  createReadStream(`${vmDir}/desktop.mem`).on("error", () => {}).resume();
  return (slot: number) => restore(vmDir, firecracker, slot);
}

// Containers of the desktop image, on the slots' Docker networks (biscotti-N, set up by net.nix).
export function containerVms(image: string) {
  return (slot: number) => startContainer(image, slot);
}

export function taskVms(start: (slot: number) => Promise<Vm>) {
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
    warm = start(slot);
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
    return ready ?? start(await acquire());
  }

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

  warmUp();
  return { run };
}

export async function restore(vmDir: string, firecracker: string, slot: number): Promise<Vm> {
  const sock = `/tmp/fc-${slot}.sock`;
  rmSync(sock, { force: true });
  const vm = spawn("nsenter", [`--net=/run/netns/fc${slot}`, firecracker, "--api-sock", sock], { stdio: "ignore" });
  // The next VM in this slot can't open the tap until this one has exited.
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

async function startContainer(image: string, slot: number): Promise<Vm> {
  const name = `biscotti-task-${slot}`;
  const network = `biscotti-${slot}`;
  const stop = () => docker("DELETE", `/containers/${name}?force=true`).catch(() => {});
  await stop();
  try {
    await docker("POST", `/containers/create?name=${name}`, {
      Image: image,
      // The container is the sandbox; Chromium's own needs privileges a container doesn't get.
      Env: ["CHROMIUM_FLAGS=--no-sandbox"],
      HostConfig: { NetworkMode: network, ShmSize: 1 << 30, ExtraHosts: [`gate:10.200.${slot}.1`] },
      NetworkingConfig: { EndpointsConfig: { [network]: { IPAMConfig: { IPv4Address: `10.200.${slot}.2` } } } },
    });
    await docker("POST", `/containers/${name}/start`);
    // Ready once the task listener answers (an empty connection is ignored).
    for (const t = Date.now(); !(await answers(`10.200.${slot}.2`, 4000)); ) {
      if (Date.now() - t > 120_000) throw new Error("the task container didn't start");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { slot, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function answers(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port }, () => (socket.end(), resolve(true))).on("error", () => resolve(false));
  });
}

const docker = (method: string, path: string, body?: object) => api("/var/run/docker.sock", method, path, body);

function api(socketPath: string, method: string, path: string, body?: object) {
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d)).on("end", () => {
        if (res.statusCode! < 300) resolve();
        else reject(new Error(`${path}: ${res.statusCode} ${text}`));
      });
    });
    req.on("error", reject).end(body && JSON.stringify(body));
  });
}

// The goal goes to pi in the VM; its last assistant text is the report, then a screenshot follows.
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

export function taskTool(
  vms: ReturnType<typeof taskVms>,
  onReport: (goal: string, result: TaskResult) => void,
  watch?: (slot: number) => string,
  track?: (goal: string) => () => void,
) {
  return defineTool({
    name: "task",
    label: "Task",
    description:
      "Start a task in a fresh, disposable Linux VM with a desktop, browser, shell and internet, for anything that needs a website, a program or files. Returns right away; the report arrives later as a message starting 'Task report'. The task agent sees only the goal, so make it complete.",
    parameters: Type.Object({ goal: Type.String() }),
    async execute(_id, { goal }) {
      const done = track?.(goal);
      const started = new Promise<number>((resolve) =>
        vms
          .run(goal, resolve)
          .then(
            (result) => onReport(goal, result),
            (err) => onReport(goal, { report: `The task failed: ${err.message}` }),
          )
          .finally(done),
      );
      // A queued task (every slot busy) doesn't hold up the reply.
      const slot = watch && (await Promise.race([started, new Promise<undefined>((r) => setTimeout(r, 3000))]));
      const text = slot ? `Task started. Its live desktop, only for a user who asks to watch or take over: ${watch(slot)}` : "Task started.";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
