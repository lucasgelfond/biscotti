import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "./support.ts";

test("publishes a page with link-preview tags, texts its link on its own, and serves it", async () => {
  const biscotti = await boot(["artifacts"]);

  await biscotti.say("Make me a page with a table comparing biscotti, shortbread and madeleines: origin and texture.");

  const pages = join(biscotti.dir, "pages");
  const files = readdirSync(pages).filter((f) => f.endsWith(".html"));
  const page = readFileSync(join(pages, files[0]), "utf8");
  const served = await fetch(`http://127.0.0.1:${process.env.PAGES_PORT}/${files[0]}`);
  const listing = await fetch(`http://127.0.0.1:${process.env.PAGES_PORT}/`);
  expect(files).toHaveLength(1);
  expect(page.toLowerCase()).toContain("madeleine");
  expect(page).toContain('<meta property="og:title"');
  expect(page).toContain('<meta property="og:image" content="https://biscotti.example.ts.net/preview.jpg">');
  expect(biscotti.sent).toContain(`https://biscotti.example.ts.net/${files[0]}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(listing.status).toBe(404);
});
