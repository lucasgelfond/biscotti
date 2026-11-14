// Opens a real box on a host with VMs, without the rest of biscotti (no channel), and keeps it until Ctrl-C.
// Usage, on the host, with the gate stopped (it holds the slots' ports):
//   docker run --rm -it --network host --env-file /var/lib/biscotti/.env -e VMS_SOCKET=/run/biscotti-vms/vms.sock \
//     -v /run/biscotti-vms:/run/biscotti-vms -v /var/lib/biscotti/vm:/var/lib/biscotti/vm:ro \
//     -v "$PWD":/app -w /app biscotti/agent node tests/box-smoke.ts "<ssh public key>" [owner/repo] [setup command]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate } from "../core/src/gate.ts";
import { gateTasks } from "../core/src/tasks.ts";

const [key, repo, setup] = process.argv.slice(2);
const gate = createGate({
  llm: { url: process.env.LLM_BASE_URL!, key: process.env.LLM_API_KEY! },
  models: { main: process.env.MODEL!, task: process.env.TASK_MODEL || process.env.MODEL!, code: process.env.CODE_MODEL || process.env.TASK_MODEL || process.env.MODEL! },
  send: async () => {},
});
// Public repos only: no token here.
const bundle = async (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), "box-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1000", `https://github.com/${name}.git`, "repo"], { cwd: dir });
    execFileSync("git", ["bundle", "create", "-q", "../in.bundle", "HEAD"], { cwd: join(dir, "repo") });
    return readFileSync(join(dir, "in.bundle"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const vms = await gateTasks(gate, process.env.VMS_SOCKET!, process.env.VM_DIR ?? "/var/lib/biscotti/vm", () => {}, () => bundle);
const started = Date.now();
const box = await vms.boxes.open({ key, repo, setup });
console.log(JSON.stringify({ ...box, seconds: (Date.now() - started) / 1000 }));
// The first Ctrl-C (SIGINT) closes the box and opens it again; the second closes it for good.
let cycled = false;
process.on("SIGINT", async () => {
  let t = Date.now();
  await vms.boxes.close(box.id);
  console.log(`closed (kept) in ${(Date.now() - t) / 1000}s`);
  if (cycled) process.exit(0);
  cycled = true;
  t = Date.now();
  const again = await vms.boxes.reopen(box.id, key);
  console.log(JSON.stringify({ reopened: again, seconds: (Date.now() - t) / 1000 }));
});
