import { defineTool } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Type } from "typebox";

// Task VMs: each task restores a fresh desktop VM from the snapshot (cua-vm/snapshots.sh), runs one pi task in it, and
// throws it away. The snapshot has a fixed guest address, so one VM runs at a time and other tasks queue.

const GUEST = "172.16.0.2";
const TASK_TIMEOUT_MS = 30 * 60_000;
let queue: Promise<unknown> = Promise.resolve();

export function runTask(vmDir: string, firecracker: string, goal: string): Promise<string> {
  const run = queue.then(() => runInVm(vmDir, firecracker, goal));
  queue = run.catch(() => {});
  return run;
}

async function runInVm(vmDir: string, firecracker: string, goal: string) {
  const sock = "/tmp/fc-task.sock";
  rmSync(sock, { force: true });
  const vm = spawn(firecracker, ["--api-sock", sock], { stdio: "ignore" });
  try {
    while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 20));
    await api(sock, "PUT", "/snapshot/load", {
      snapshot_path: `${vmDir}/desktop.snap`,
      mem_backend: { backend_type: "File", backend_path: `${vmDir}/desktop.mem` },
      resume_vm: true,
    });
    return await runPi(GUEST, goal);
  } finally {
    // Wait for the exit too: the next VM can't open the tap until this one has let go of it.
    const exited = once(vm, "exit");
    vm.kill("SIGKILL");
    await exited;
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

// Sends the goal to the VM's task listener and reads pi's JSON events; the last assistant text is the report.
function runPi(host: string, goal: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port: 4000 }, () => socket.end(goal));
    socket.setTimeout(TASK_TIMEOUT_MS, () => socket.destroy(new Error("task timed out")));
    let report = "";
    createInterface({ input: socket }).on("line", (line) => {
      const event = JSON.parse(line) as { type: string; message?: { role: string; content: { type: string; text?: string }[] } };
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const text = event.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
      if (text) report = text;
    });
    socket.on("error", reject).on("close", () => resolve(report || "The task ended without a report."));
  });
}

// Starts a task and returns right away; `onReport` gets the report when the task ends.
export function taskTool(vmDir: string, firecracker: string, onReport: (goal: string, report: string) => void) {
  return defineTool({
    name: "task",
    label: "Task",
    description:
      "Start a task in a fresh, disposable Linux VM with a desktop, browser, shell and internet, for anything that needs a website, a program or files. Returns right away; the report arrives later as a message starting 'Task report'. The task agent sees only the goal, so make it complete.",
    parameters: Type.Object({ goal: Type.String() }),
    async execute(_id, { goal }) {
      runTask(vmDir, firecracker, goal).then(
        (report) => onReport(goal, report),
        (err) => onReport(goal, `The task failed: ${err.message}`),
      );
      return { content: [{ type: "text" as const, text: "Task started." }], details: {} };
    },
  });
}
