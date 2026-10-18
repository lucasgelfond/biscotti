import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgent } from "../agent/src/agent.ts";
import { openDb } from "../agent/src/db.ts";
import { pageTool } from "../agent/src/pages.ts";

test("publishes a page and texts its link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "biscotti-"));
  const pages = join(dir, "pages");
  const db = openDb(join(dir, "biscotti.db"));
  const agent = await createAgent({ db, dir, tools: [pageTool(pages, "https://biscotti.example.ts.net:8445")] });

  const reply = await agent.reply("Make me a page with a table comparing biscotti, shortbread and madeleines: origin and texture.");

  const files = readdirSync(pages);
  expect(files).toHaveLength(1);
  expect(readFileSync(join(pages, files[0]), "utf8").toLowerCase()).toContain("madeleine");
  expect(reply).toContain(`https://biscotti.example.ts.net:8445/${files[0]}`);
});
