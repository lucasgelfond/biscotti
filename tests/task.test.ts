import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { SLOTS, taskVms } from "../core/src/tasks.ts";

// Runs on the Pi, with the live agent stopped (it holds the slots and the gate's ports).
const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);
const vms = onThePi ? taskVms(VM_DIR, FIRECRACKER) : undefined;

if (onThePi) {
  const gate = createGate({ llm: { url: process.env.LLM_BASE_URL!, key: process.env.LLM_API_KEY! }, models: { task: process.env.TASK_MODEL! }, send: async () => {} });
  for (const slot of SLOTS) await gate.listen(`10.200.${slot}.1`, 80);
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
