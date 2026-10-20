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
    if (req.url === "/seats") return html(SEAT_MAP);
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

// A seat map drawn on a canvas, so no seat is an element: green seats are open, grey ones taken.
const SEAT_MAP = `<h3>Choose seats</h3><canvas id="c" width="900" height="520"></canvas><p id="sel">Selected: none</p>
<div style="display:flex;gap:16px"><span><i style="display:inline-block;width:14px;height:14px;background:#2a9d4b"></i><span>Available</span></span>
<span><i style="display:inline-block;width:14px;height:14px;background:#1d4ed8"></i><span>Selected</span></span>
<span><i style="display:inline-block;width:14px;height:14px;background:#bbb"></i><span>Unavailable</span></span></div><script>
const c = document.getElementById("c"), x = c.getContext("2d"), rows = "ABCDEFGHIJ", taken = new Set(), picked = [];
for (const r of rows) for (let i = 1; i <= 14; i++) if ((r.charCodeAt(0) * 7 + i * 13) % 10 < 6 && !(r == "F" && i >= 6 && i <= 9)) taken.add(r + i);
const at = (ri, i) => [60 + i * 52, 50 + ri * 46];
function draw() { x.fillStyle = "#333"; x.fillRect(150, 5, 600, 18); [...rows].forEach((r, ri) => { x.fillStyle = "#000"; x.fillText(r, 20, at(ri, 1)[1] + 20);
  for (let i = 1; i <= 14; i++) { const [px, py] = at(ri, i); x.fillStyle = picked.includes(r + i) ? "#1d4ed8" : taken.has(r + i) ? "#bbb" : "#2a9d4b"; x.fillRect(px, py, 40, 32); } }); }
draw();
c.onclick = (e) => { const b = c.getBoundingClientRect(); [...rows].forEach((r, ri) => { for (let i = 1; i <= 14; i++) { const [px, py] = at(ri, i);
  if (e.clientX - b.left >= px && e.clientX - b.left <= px + 40 && e.clientY - b.top >= py && e.clientY - b.top <= py + 32 && !taken.has(r + i) && !picked.includes(r + i)) picked.push(r + i); } });
  document.getElementById("sel").textContent = "Selected: " + (picked.join(", ") || "none"); draw(); };
</script>`;

// Jev's box over a picture is right most of the time, not every time; a miss is retried once the page shows it.
test.skipIf(!live)("picks an open seat on a canvas seat map, from a screenshot", { timeout: 180_000, retry: 2 }, async () => {
  const site = shop();
  const vm = await harness(9475);

  const report = await vm.errand("Select one seat near the middle, then report which seat is selected. Don't buy anything.", `${site.url()}/seats`);
  vm.close();
  site.close();

  const seats = [...report.matchAll(/\b([A-J])(\d{1,2})\b/g)].map((m) => m[0]);
  expect(seats.length).toBeGreaterThanOrEqual(1);
  expect(report).toMatch(/Goal done\./);
});

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
