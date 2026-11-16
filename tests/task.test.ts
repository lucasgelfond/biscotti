import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { restore } from "../plugins/firecracker/firecracker.ts";
import { taskEvents, type Host } from "../core/src/plugin.ts";
import { SLOTS } from "../plugins/firecracker/firecracker.ts";

// Runs on the Pi, with the live service stopped (it holds the slots and the gate's ports): the real gate and agent
// (its settings from the environment, as the service's), tasks in Firecracker VMs, their tools through pi-env.
const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);
process.env.API_PORT = "0";
const host: Host = { slots: SLOTS, restore: (slot) => restore(VM_DIR, FIRECRACKER, slot, 1100 + slot) };
const { boot } = await import("./support.ts");
const vms = onThePi ? (await boot([], undefined, undefined, host)).vms : undefined;
const started: number[] = [];
taskEvents.on("event", (e) => void (e.type === "started" && e.slot !== undefined && started.push(e.slot)));

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
  started.length = 0;
  const goal = (n: number) => `Run \`echo task-${n}\` in a shell and report exactly what it printed.`;

  const began = Date.now();
  const reports = await Promise.all([1, 2, 3].map((n) => vms!.run(goal(n))));
  const seconds = (Date.now() - began) / 1000;

  expect([...started].sort()).toEqual([1, 2, 3]);
  reports.forEach(({ report }, i) => expect(report).toContain(`task-${i + 1}`));
  expect(seconds).toBeLessThan(90);
});

test.skipIf(!onThePi)("keeps a VM restored ahead of time, so a short task finishes in seconds", async () => {
  // Let the VM the last test freed be restored again.
  await new Promise((r) => setTimeout(r, 2000));

  const began = Date.now();
  const { report } = await vms!.run("Reply with just the word ready. Use no tools.");
  const seconds = (Date.now() - began) / 1000;

  expect(report.toLowerCase()).toContain("ready");
  // The VM's setup for pi-env (the gate's key, pi-env's daemon sent to it) and the check of its final screen come on
  // top of the model's answer.
  expect(seconds).toBeLessThan(20);
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

  const { bundle } = await vms!.run(goal, { repo: repo.bundle });

  expect(bundle).toBeDefined();
  writeFileSync(`${repo.dir}.out.bundle`, bundle!);
  execFileSync("git", ["-C", repo.dir, "pull", "-q", "--ff-only", `${repo.dir}.out.bundle`, "HEAD"]);
  expect(execFileSync("node", ["test.js"], { cwd: repo.dir, encoding: "utf8" })).toContain("ok");
});
