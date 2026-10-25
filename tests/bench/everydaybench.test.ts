import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openDb } from "../../core/src/memory.ts";
import { secret } from "../../core/src/plugin.ts";
import { targets } from "../../plugins/secure-fill/index.ts";
import { CHROME, chrome } from "../support.ts";
import { CONTROL, everydayBenchTasks } from "./everydaybench.ts";

// With EverydayBench running on this machine (pnpm build && node server.ts in EverydayBench), as the VMs' browsers
// reach it.
const up = await fetch(`${CONTROL}/health`).then((r) => r.ok, () => false);

test.skipIf(!up || !existsSync(CHROME))("a EverydayBench task: its prompt, its start page in the browser, logins in the vault, graded by EverydayBench", { timeout: 60_000 }, async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "everydaybench-")), "biscotti.db"), "test");
  const tasks = await everydayBenchTasks(db);
  const browser = await chrome(9611, "about:blank", ["--host-resolver-rules=MAP *.everydaybench.test 127.0.0.1"]);

  try {
    const task = await tasks["tickets/lumiscope-two-together"]!();
    await task.setup!(browser.url);
    const page = (await targets(browser.url)).find((t) => t.type === "page")!;

    expect(task.goal).toContain("Get two seats next to each other");
    expect(task.goal).toContain("Lumiscope Cinemas is open in the browser.");
    expect(page.url).toBe("http://lumiscope.everydaybench.test:8700/");
    expect(secret(db, "Lumiscope")).toEqual({ email: "sam@mailmoss.test", password: "lighthouse-keeper-9" });
    // Nothing bought: the grade fails, and says why.
    expect(await task.pass("Done!")).toBe(false);
    expect(task.graded).toMatchObject({ pass: false, parts: { ASSERT: false, ANSWER: false } });
  } finally {
    browser.close();
  }
});
