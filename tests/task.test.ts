import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { runTask } from "../agent/src/sandbox.ts";

// Task VMs need Linux with KVM, the snapshot from cua-vm/snapshots.sh and the bridge, so this runs on the Pi.
const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);

test.skipIf(!onThePi)("runs a task in a fresh VM and returns the task agent's report", async () => {
  const goal = "Run `uname -m` and `cat /etc/os-release` in a shell. Report the machine architecture and the distro's ID.";

  const report = await runTask(VM_DIR, FIRECRACKER, goal);

  expect(report).toMatch(/aarch64|x86_64/);
  expect(report.toLowerCase()).toContain("debian");
});

test.skipIf(!onThePi)("starts every task from a clean VM", async () => {
  await runTask(VM_DIR, FIRECRACKER, "Create the file /tmp/left-behind with the text hello. Report done.");

  const report = await runTask(VM_DIR, FIRECRACKER, "Does /tmp/left-behind exist? Check with `ls`, then answer only EXISTS or MISSING.");

  expect(report).toContain("MISSING");
});
