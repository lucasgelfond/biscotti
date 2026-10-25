import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { vault } from "../core/src/schema.ts";
import { browse, cycle, firstUrl, holds, parsePlan, ranked, sameAs, slotFor, unauthorized, unsure, type Decide, type Write } from "../plugins/jev-quick-browse/loop.ts";
import { effect, keywords, openPage, pngSize, relevant, scaleFor, today, type Element, type Page } from "../plugins/jev-quick-browse/page.ts";
import { harness } from "./dcu-harness.ts";
import { CHROME, chrome } from "./support.ts";

const live = existsSync(CHROME) && !!process.env.TYPESAFE_API_KEY;
const haveChrome = existsSync(CHROME);

// The loop's own logic, without a model or a browser.
describe("jev loop logic", () => {
  const el = (i: number, text: string, more: Partial<Element> = {}): Element => ({ i, tag: "button", role: "button", text, field: false, secret: false, covered: false, ...more });

  test("page text is cut to the blocks that bear on the goal, in page order, keeping prices and times", () => {
    const nav = Array.from({ length: 200 }, (_, i) => `Menu item ${i} about shipping, careers and our story`);
    const blocks = [...nav.slice(0, 100), "Blue Mug", "Price: $12.50, ships in 2 days", ...nav.slice(100), "Showing at 7:40 PM tonight"];
    const kept = relevant(blocks, keywords("Find the price of the Blue Mug."), 600);
    expect(kept.length).toBeLessThanOrEqual(600);
    expect(kept).toContain("Price: $12.50");
    expect(kept).toContain("Showing at 7:40 PM");
    expect(kept.indexOf("Blue Mug")).toBeLessThan(kept.indexOf("$12.50"));
    // Under the budget, everything as it was.
    expect(relevant(["a", "b"], ["x"], 100)).toBe("a\nb");
    expect(keywords("Open the article about the Blue Mug")).toEqual(["blue", "mug"]);
  });

  test("equivalent targets share one probability: two unsure picks become one sure one", () => {
    const [a, b, c] = [el(1, "Showtimes", { tag: "a", href: "https://x/st" }), el(2, "Showtimes", { tag: "a", href: "https://x/st" }), el(3, "Tickets")];
    expect(sameAs(a)).toBe(sameAs(b));
    expect(sameAs(el(4, "Add to cart", { near: "Anora" }))).not.toBe(sameAs(el(5, "Add to cart", { near: "Wicked" })));
    const probabilities = { "1": 0.3, "2": 0.3, "3": 0.4 };
    expect(unsure(ranked(probabilities))).toBe(true);
    const byId = new Map([a, b, c].map((e) => [String(e.i), e]));
    const picks = ranked(probabilities, (k) => sameAs(byId.get(k)!));
    expect(picks[0].p).toBeCloseTo(0.6);
    expect(["1", "2"]).toContain(picks[0].key);
    expect(unsure(picks)).toBe(false);
  });

  test("a consequential click is gated by the kinds the goal authorized", () => {
    expect(unauthorized("Place order", [])).toBe("pay");
    expect(unauthorized("Place order", ["pay"])).toBeUndefined();
    expect(unauthorized("Book now", ["pay"])).toBe("book");
    expect(unauthorized("Send message", ["book"])).toBe("send");
    expect(unauthorized("Delete account", [])).toBe("delete");
    expect(unauthorized("Add to cart", [])).toBeUndefined();
    expect(unauthorized("Showtimes", [])).toBeUndefined();
  });

  test("a prepared value goes into a field only when Jev is sure it fits and the field doesn't hold it", () => {
    const values = { "destination city": "Boston", "check-in date": "Nov 3" };
    const field = el(1, "Where to?", { tag: "input", role: "textbox", field: true });
    const slot = { choice: "destination city", confidence: 0.9 };
    expect(slotFor(slot, { noul: 0.9 }, values, field)).toBe("Boston");
    expect(slotFor(slot, { noul: 0.5 }, values, field)).toBeUndefined();
    expect(slotFor(slot, { noul: 0.9 }, values, { ...field, value: "boston" })).toBeUndefined();
    expect(holds({ ...field, value: " Nov 3" }, values)).toBe(true);
    expect(holds({ ...field, value: "Nov 4" }, values)).toBe(false);
  });

  test("going in circles is a steady repeat of the same few states", () => {
    expect(cycle(["a", "b", "a", "b", "a"])).toBe(2);
    expect(cycle(["x", "a", "b", "c", "a", "b", "c", "a"])).toBe(3);
    expect(cycle(["a", "a", "a"])).toBe(0);
    expect(cycle(["a", "b", "a", "c", "a"])).toBe(0);
  });

  test("the plan comes from the writer's JSON, never with credentials, and the caller's values win", () => {
    const plan = parsePlan(
      'Here:\n```json\n{"requirements": ["results shown", "price on screen"], "values": {"city": "Boston", "password": "x", "card": "4111 1111"}, "allowed": ["book", "fly"]}\n```',
      "goal",
      { city: "Cambridge" },
    );
    expect(plan).toEqual({ requirements: ["results shown", "price on screen"], values: { city: "Cambridge" }, allowed: ["book"] });
    expect(parsePlan("not json", "Find the price")).toEqual({ requirements: ["Find the price"], values: {}, allowed: [] });
  });

  test("the first address in a reply or a goal, without the punctuation around it", () => {
    expect(firstUrl('Open "https://www.saucedemo.com/".')).toBe("https://www.saucedemo.com/");
    expect(firstUrl("On https://news.ycombinator.com report the top story")).toBe("https://news.ycombinator.com");
    expect(firstUrl("NONE")).toBeUndefined();
  });

  test("a password the goal spells out is kept to type verbatim; one it doesn't is not", () => {
    const said = '{"requirements": ["logged in"], "values": {"username": "standard_user", "password": "secret_sauce"}}';
    expect(parsePlan(said, "Log in as standard_user with password secret_sauce").values).toEqual({ username: "standard_user", password: "secret_sauce" });
    expect(parsePlan(said, "Log in to my account").values).toEqual({ username: "standard_user" });
  });

  test("today names the next months, across a new year", () => {
    expect(today(new Date(2026, 9, 24))).toBe("2026-10-24 (Saturday); next months: November 2026, December 2026");
    expect(today(new Date(2026, 11, 5))).toContain("next months: January 2027, February 2027");
  });

  test("screenshots come out inside Jev's 280 to 1568 pixels on any pixel ratio", () => {
    for (const [w, h, dpr] of [[1280, 900, 1], [1280, 900, 2], [100, 100, 1], [1500, 300, 3]]) {
      const s = scaleFor(w, h, dpr);
      expect(Math.max(w, h) * s * dpr).toBeLessThanOrEqual(1568);
      expect(Math.min(w, h) * s * dpr).toBeGreaterThanOrEqual(280);
    }
    const header = Buffer.alloc(24);
    header.writeUInt32BE(1500, 16);
    header.writeUInt32BE(953, 20);
    expect(pngSize(header.toString("base64"))).toEqual({ w: 1500, h: 953 });
  });

  test("an action's effect, as the next decision reads it", () => {
    const field = el(7, "City", { tag: "input", role: "combobox", field: true, value: "Bos" });
    const page = (more: Partial<Page>): Page => ({ url: "https://x/", title: "", elements: [], text: [], alerts: [], suggestions: 0, canScroll: false, canGoBack: false, pictures: [], legend: {}, ...more });
    expect(effect(page({ elements: [{ ...field, value: "" }] }), page({ elements: [field], suggestions: 4 }), { ...field, value: "" })).toBe(
      `value now "Bos"; 4 suggestions opened: choose one, don't type again`,
    );
    expect(effect(page({ dialog: "Choose a date" }), page({ url: "https://x/2" }))).toBe("URL changed to https://x/2; dialog closed");
    expect(effect(page({}), page({}))).toBe("nothing changed");
  });
});

// A page as the reader sees it (evaluated in Chrome, where TypeScript can't check it), then the whole loop with a
// scripted Jev and writer: no keys needed.
const PAGE = `<!doctype html><title>Cinema</title><main role="main"><h1>Book tickets</h1><p>Showing Friday, Nov 6, 2026. Tickets from $12.50.</p>
<label for="city">City</label><input id="city" role="combobox" value="Bos"><label>Password <input type="password" value="hunter2"></label>
<select aria-label="Tickets"><option>1</option><option selected>2</option></select><a href="/a">Showtimes</a><a href="/a">Showtimes</a>
<div><h3>Anora</h3><button>Add to cart</button></div><div><h3>Wicked</h3><button>Add to cart</button></div><p role="alert">Please choose a seat.</p>
<svg width="300" height="200" role="img"><text x="10" y="20">Screen</text><rect x="10" y="50" width="20" height="20" aria-label="Seat F7" style="cursor:pointer"/></svg></main>
<div id="d" role="dialog" aria-modal="true" aria-label="Choose a date" style="position:fixed;top:0;right:0;background:#fff"><p>November 2026</p>
<div aria-label="6 November 2026" style="cursor:pointer">6</div><button onclick="d.remove()">Done</button></div>`;

const SEARCH = `<!doctype html><title>Hotels</title><h1>Find a hotel</h1><label for="c">Destination</label><input id="c" role="combobox">
<ul role="listbox" id="s"></ul><button id="go">Search</button><button>Place order</button><p id="r"></p><script>
c.addEventListener("input", () => setTimeout(() => { s.innerHTML = ""; for (const name of c.value ? ["Boston, MA", "Bossier City, LA"] : []) {
  const li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = name; li.onclick = () => { c.value = name; s.innerHTML = ""; }; s.append(li); } }, 300));
go.onclick = () => setTimeout(() => { r.textContent = "Hotel Boston: $189 per night"; history.pushState({}, "", "#results"); }, 100);
</script>`;

function serve(pages: Record<string, string>) {
  const server = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(pages[req.url ?? "/"] ?? "<p>not here</p>")).listen(0, "127.0.0.1");
  return { url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test.skipIf(!haveChrome)("reads fields, calendar days and SVG seats; masks secrets; shows only a modal's text; keeps ids", { timeout: 60_000 }, async () => {
  const site = serve({ "/": PAGE });
  const browser = await chrome(9481, "about:blank", ["--window-size=1280,900", "--force-device-scale-factor=2"]);
  const tab = await openPage(browser.url);
  try {
    tab.rank(["anora"]);
    await tab.navigate(`${site.url()}/`);
    const page = await tab.settled("");
    const by = (text: string) => page.elements.find((e) => e.text === text);
    expect(page.dialog).toBe("Choose a date");
    expect(page.elements.slice(0, 2).map((e) => e.text)).toEqual(["6 November 2026", "Done"]);
    expect(page.text).toEqual(["November 2026"]);
    expect(by("City")).toMatchObject({ field: true, value: "Bos", role: "combobox" });
    expect(by("Password")).toMatchObject({ secret: true, value: "(hidden)" });
    expect(JSON.stringify(page)).not.toContain("hunter2");
    expect(by("Tickets")).toMatchObject({ value: "2", options: ["1", "2"] });
    expect(by("Seat F7")?.tag).toBe("rect");
    expect(page.elements.filter((e) => e.text === "Showtimes")).toHaveLength(1);
    expect(page.elements.filter((e) => e.text === "Add to cart").map((e) => e.near)).toEqual(["Anora", "Wicked"]);
    expect(page.alerts).toEqual(["Please choose a seat."]);
    expect(await tab.click(by("Done")!.i)).toBe(true);
    const after = await tab.settled(JSON.stringify(page));
    expect(after.elements.find((e) => e.text === "City")?.i).toBe(by("City")!.i);
    expect(after.text.join(" ")).toContain("$12.50");
    const size = pngSize(await tab.screenshot());
    expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(1568);
    expect(Math.min(size.w, size.h)).toBeGreaterThanOrEqual(280);
  } finally {
    tab.close();
    browser.close();
    site.close();
  }
});

// Jev as a script: types the prepared value, picks the suggestion, searches, says done; with `order`, it then clicks
// Place order, which the goal doesn't authorize.
function scripted(order = false): Decide {
  const choice = (criteria: Record<string, unknown>, pick: string | undefined) => {
    const keys = Object.keys(criteria);
    const key = pick ?? keys[0];
    return { choice: key, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === key ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])) };
  };
  return async (state: any, questions: any) => {
    if (questions.commits) return { commits: { noul: 0.9 } };
    const find = (q: any, re: RegExp) => Object.entries(q?.criteria ?? {}).find(([, v]) => re.test(JSON.stringify(v)))?.[0];
    const value = (state.elements as string[]).find((e) => e.includes('"Destination"'));
    const results = state.page.url.endsWith("#results");
    const [op, target] =
      results ? (order ? ["CLICK", /Place order/] : ["DONE"])
      : !value?.includes(" = ") ? ["TYPE_TEXT", /Destination/]
      : state.page.suggestions_showing ? ["CLICK", /Boston, MA/]
      : ["CLICK", /"Search"/];
    return {
      operation: choice(questions.operation.criteria, op as string),
      ...(questions.click_target && { click_target: choice(questions.click_target.criteria, find(questions.click_target, (target as RegExp) ?? /x^/)) }),
      ...(questions.type_target && { type_target: choice(questions.type_target.criteria, find(questions.type_target, /Destination/)) }),
      ...(questions.text_slot && { text_slot: choice(questions.text_slot.criteria, "destination"), slot_fits: { noul: 0.9 } }),
    };
  };
}
const writer: Write = async (instructions) =>
  instructions.startsWith("You plan") ? '{"requirements": ["hotel results for Boston are shown"], "values": {"destination": "Bos"}, "allowed": []}'
  : instructions.includes("says the goal is done") ? '{"met": [1], "done": true}'
  : instructions.startsWith("A browser worked") ? "Hotel Boston is $189 a night.\nRequirements met: 1\nGoal done."
  : '{"hint": "search for Boston"}';

test.skipIf(!haveChrome)("browses with a scripted Jev: prepared text, a suggestion, a search, a checked done; stops before an unauthorized order", { timeout: 90_000 }, async () => {
  const site = serve({ "/": SEARCH });
  const browser = await chrome(9482, "about:blank", ["--window-size=1280,900"]);
  try {
    const done = await browse("Find a hotel in Boston", browser.url, { decide: scripted(), write: writer }, `${site.url()}/`);
    expect(done.outcome).toBe("done");
    expect(done.steps[0]).toMatch(/typed "Bos".*2 suggestions opened/);
    expect(done.steps[1]).toMatch(/clicked .*"Boston, MA".*"Destination" now "Boston, MA"/);
    expect(done.requirements).toEqual([{ requirement: "hotel results for Boston are shown", met: true }]);

    const order = await browse("Find a hotel in Boston", browser.url, { decide: scripted(true), write: writer }, `${site.url()}/`);
    expect(order.outcome).toMatch(/stopped before .*Place order.*\(pay\)/);
  } finally {
    browser.close();
    site.close();
  }
});

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
