import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgent } from "../agent/src/agent.ts";
import { openDb } from "../agent/src/db.ts";
import { pageTool } from "../agent/src/pages.ts";

test("publishes a page with link-preview tags and texts its link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "biscotti-"));
  const pages = join(dir, "pages");
  const db = openDb(join(dir, "biscotti.db"));
  const agent = await createAgent({ db, dir, tools: [pageTool(pages, "https://biscotti.example.ts.net:8445")] });

  const reply = await agent.reply("Make me a page with a table comparing biscotti, shortbread and madeleines: origin and texture.");

  const files = readdirSync(pages).filter((f) => f.endsWith(".html"));
  const page = readFileSync(join(pages, files[0]), "utf8");
  expect(files).toHaveLength(1);
  expect(page.toLowerCase()).toContain("madeleine");
  expect(page).toContain('<meta property="og:title"');
  expect(page).toContain('<meta property="og:image" content="https://biscotti.example.ts.net:8445/preview.jpg">');
  expect(reply).toContain(`https://biscotti.example.ts.net:8445/${files[0]}`);
});
