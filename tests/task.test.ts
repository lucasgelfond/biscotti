import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { restore, SLOTS, taskVms } from "../core/src/tasks.ts";

// Runs on the Pi, with the live agent stopped (it holds the slots and the gate's ports).
const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);
const vms = onThePi ? taskVms((slot) => restore(VM_DIR, FIRECRACKER, slot, 1100 + slot)) : undefined;

if (onThePi) {
  const gate = createGate({ llm: { url: process.env.LLM_BASE_URL!, key: process.env.LLM_API_KEY! }, models: { task: process.env.TASK_MODEL! }, send: async () => {} });
  for (const slot of SLOTS) await gate.listen(`10.200.${slot}.1`, 80, { slot });
}

test.skipIf(!onThePi)("runs a task in a fresh VM and returns its report and final screen", async () => {
  const goal = "Run `uname -m` and `cat /etc/os-release` in a shell. Report the machine architecture and the distro's ID.";

  const { report, screenshot } = await vms!.run(goal);

  expect(report).toMatch(/aarch64|x86_64/);
  expect(report.toLowerCase()).toContain("debian");
  expect(screenshot?.subarray(1, 4).toString()).toBe("PNG");
});

test.skipIf(!onThePi)("starts every task from a clean VM", async () => {
  await vms!.run("Create the file /tmp/left-behind with the text hello. Report done.");

  const { report } = await vms!.run("Does /tmp/left-behind exist? Check with `ls`, then answer only EXISTS or MISSING.");

  expect(report).toContain("MISSING");
});

test.skipIf(!onThePi)("runs three tasks at once, each in its own slot", async () => {
  const slots: number[] = [];
  const goal = (n: number) => `Run \`echo task-${n}\` in a shell and report exactly what it printed.`;

  const started = Date.now();
  const reports = await Promise.all([1, 2, 3].map((n) => vms!.run(goal(n), (slot) => slots.push(slot))));
  const seconds = (Date.now() - started) / 1000;

  expect([...slots].sort()).toEqual([1, 2, 3]);
  reports.forEach(({ report }, i) => expect(report).toContain(`task-${i + 1}`));
  expect(seconds).toBeLessThan(90);
});

test.skipIf(!onThePi)("keeps a VM restored ahead of time, so a short task finishes in seconds", async () => {
  // Let the VM the last test freed be restored again.
  await new Promise((r) => setTimeout(r, 2000));

  const started = Date.now();
  const { report } = await vms!.run("Reply with just the word ready. Use no tools.");
  const seconds = (Date.now() - started) / 1000;

  expect(report.toLowerCase()).toContain("ready");
  expect(seconds).toBeLessThan(3);
});

// A repo with a function that has a bug and a test that shows it, as a git bundle.
function buggyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "task-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(`${dir}/greet.js`, 'export const greet = (name) => "Hello " + name;\n');
  writeFileSync(`${dir}/test.js`, 'import { greet } from "./greet.js";\nif (greet("Ada") !== "Hello, Ada!") throw new Error(`got ${greet("Ada")}`);\nconsole.log("ok");\n');
  writeFileSync(`${dir}/package.json`, '{ "type": "module", "scripts": { "test": "node test.js" } }\n');
  git("add", "-A");
  git("commit", "-qm", "greet");
  git("bundle", "create", "-q", `${dir}.bundle`, "HEAD", "main");
  return { dir, bundle: readFileSync(`${dir}.bundle`) };
}

test.skipIf(!onThePi)("fixes a bug in a repo it's given and returns the commits", { timeout: 600_000 }, async () => {
  const repo = buggyRepo();
  const goal = "greet() in greet.js should greet with a comma and an exclamation mark: greet('Ada') is 'Hello, Ada!'. Fix it, and check with npm test.";

  const { bundle } = await vms!.run(goal, undefined, { repo: repo.bundle });

  expect(bundle).toBeDefined();
  writeFileSync(`${repo.dir}.out.bundle`, bundle!);
  execFileSync("git", ["-C", repo.dir, "pull", "-q", "--ff-only", `${repo.dir}.out.bundle`, "HEAD"]);
  expect(execFileSync("node", ["test.js"], { cwd: repo.dir, encoding: "utf8" })).toContain("ok");
});
