import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { vault } from "../core/src/schema.ts";
import { CHROME, harness } from "./dcu-harness.ts";

const live = existsSync(CHROME) && !!process.env.TYPESAFE_API_KEY;

// A shop with a login: the right username and password show the account page, anything else an error.
const PASSWORD = "hunter2-biscotti";
function shop() {
  const logins: string[] = [];
  const page = (body: string) => `<!doctype html><title>Mug Shop</title>${body}`;
  const server = createServer(async (req, res) => {
    const html = (body: string) => res.writeHead(200, { "Content-Type": "text/html" }).end(page(body));
    if (req.url === "/blue") return html(`<h1>Blue Mug</h1><p>Price: $12.50</p>`);
    if (req.url === "/login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      logins.push(form.get("username") ?? "");
      if (form.get("username") === "ada@example.com" && form.get("password") === PASSWORD) return html(`<h1>Your account</h1><p>Latest order #4471: shipped on October 18.</p>`);
      return html(`<p>Wrong username or password.</p>`);
    }
    if (req.url === "/login")
      return html(`<h1>Sign in</h1><form method="post" action="/login"><input name="username" aria-label="Email"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>`);
    html(`<h1>Mug Shop</h1><a href="/login">Sign in</a><ul><li><a href="/red">Red Mug</a></li><li><a href="/blue">Blue Mug</a></li></ul>`);
  }).listen(0, "127.0.0.1");
  return { url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logins, close: () => server.close() };
}

test.skipIf(!live)("finds a price a click away, deciding each step with Jev", { timeout: 120_000 }, async () => {
  const site = shop();
  const vm = await harness(9460);

  const report = await vm.errand("Find the price of the Blue Mug.", `${site.url()}/`);
  vm.close();
  site.close();

  expect(report).toContain("12.50");
  expect(report).toContain("(done,");
});

test.skipIf(!live)("logs in with a saved login, filled by the vault once the owner approves", { timeout: 180_000 }, async () => {
  const site = shop();
  const vm = await harness(9470);
  vm.db.insert(vault).values({ name: "Mug Shop login", fields: ["username", "password"], value: { username: "ada@example.com", password: PASSWORD } }).run();

  const report = await vm.errand("Sign in to the Mug Shop and report the status of my latest order.", `${site.url()}/login`);
  vm.close();
  site.close();

  expect(vm.asked.join("\n")).toContain("Mug Shop login");
  expect(site.logins).toContain("ada@example.com");
  expect(report).toMatch(/shipped/i);
  expect(report).not.toContain(PASSWORD);
});
