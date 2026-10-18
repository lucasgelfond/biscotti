import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { runTask } from "../core/src/tasks.ts";

// Task VMs need Linux with KVM, the snapshot from core/vm/snapshots.sh and the bridge, so this runs on the Pi.
const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);

test.skipIf(!onThePi)("runs a task in a fresh VM and returns its report and final screen", async () => {
  const goal = "Run `uname -m` and `cat /etc/os-release` in a shell. Report the machine architecture and the distro's ID.";

  const { report, screenshot } = await runTask(VM_DIR, FIRECRACKER, goal);

  expect(report).toMatch(/aarch64|x86_64/);
  expect(report.toLowerCase()).toContain("debian");
  expect(screenshot?.subarray(1, 4).toString()).toBe("PNG");
});

test.skipIf(!onThePi)("starts every task from a clean VM", async () => {
  await runTask(VM_DIR, FIRECRACKER, "Create the file /tmp/left-behind with the text hello. Report done.");

  const { report } = await runTask(VM_DIR, FIRECRACKER, "Does /tmp/left-behind exist? Check with `ls`, then answer only EXISTS or MISSING.");

  expect(report).toContain("MISSING");
});

test.skipIf(!onThePi)("runs three tasks at once, each in its own slot", async () => {
  const slots: number[] = [];
  const goal = (n: number) => `Run \`echo task-${n}\` in a shell and report exactly what it printed.`;

  const started = Date.now();
  const reports = await Promise.all([1, 2, 3].map((n) => runTask(VM_DIR, FIRECRACKER, goal(n), (slot) => slots.push(slot))));
  const seconds = (Date.now() - started) / 1000;

  expect([...slots].sort()).toEqual([1, 2, 3]);
  reports.forEach(({ report }, i) => expect(report).toContain(`task-${i + 1}`));
  expect(seconds).toBeLessThan(90);
});
