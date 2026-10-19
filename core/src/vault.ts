import { createHmac, randomBytes, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import { declined, localTools, text, type LocalTool, type Plugin } from "./plugin.ts";
import type { Db } from "./memory.ts";
import { eq } from "drizzle-orm";
import { vault } from "./schema.ts";

// Logins, cards and licenses. The gate types them into task VMs' pages: no model ever sees a secret, and none is texted.

const PORT = 4791;
const FORM_TTL_MS = 30 * 60_000;
// Fields that identify rather than unlock (shown to the agent, never scrubbed), unless the name says otherwise, as
// "login password" or "account number" do.
const IDENTIFYING = /user|e-?mail|login|name|exp|zip|postal|address|phone/i;
const SECRET = /pass|pin\b|cvc|cvv|code|secret|token|key|totp|number|ssn|account|security|answer/i;
const isPublic = (field: string) => IDENTIFYING.test(field) && !SECRET.test(field);
// Shorter values (a ZIP, a month) would scrub ordinary text.
const MIN_SCRUBBED = 6;

// The slot's VM's Chromium, over DevTools.
const browser = (slot?: number) => process.env.TASK_BROWSER ?? `http://10.200.${slot}.2:9223`;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function form(name: string, fields: string[]) {
  const inputs = fields.map((f) => `<label>${escape(f)}<input name="f:${escape(f)}" autocomplete="off"></label>`).join("");
  return `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title>
<style>body{font:17px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:0 0 1rem}
input:not([type=checkbox]){display:block;width:100%;font:inherit;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.6rem 1.2rem}</style>
<h2>${escape(name)}</h2><form method="post">${inputs}
<button>Save</button></form>`;
}

// Every saved secret value, for the gate to keep out of model calls.
export function secrets(db: Db) {
  return db
    .select()
    .from(vault)
    .all()
    .flatMap((row) => Object.entries(row.value).filter(([field, value]) => !isPublic(field) && value.length >= MIN_SCRUBBED).map(([field, value]) => ({ label: `${row.name}.${field}`, value })));
}

// A new password, like Apple's: three groups of six letters and digits, with at least one of each case and a digit, so
// it suits most sites' rules.
export function newPassword() {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const password = [0, 1, 2].map(() => Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join("")).join("-");
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) return password;
  }
}

// The current code for an authenticator setup key (base32, or an otpauth:// URI), per RFC 6238.
export function totp(setup: string, now = Date.now()) {
  const key = (setup.match(/secret=([^&]+)/i)?.[1] ?? setup).toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bits = [...key].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hash = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))).update(counter).digest();
  return String((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function devtools(url: string) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const pending = new Map<number, (msg: { result?: any; error?: { message: string } }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  let id = 0;
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      pending.set(++id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  // Scripts run in a world of their own, where the page's scripts can't change what they see (a faked hasFocus).
  const { frameTree } = await send("Page.getFrameTree");
  const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "biscotti" });
  const run = (expression: string, returnByValue = true) => send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue });
  const evaluate = async (expression: string) => (await run(expression)).result.value;
  // Where typing would go: the tab's site, and the frame's when the focused field is in one.
  async function where(targets: Target[]) {
    const { frameTree } = await send("Page.getFrameTree");
    const page = site(frameTree.frame.url);
    const { result } = await run("document.activeElement", false);
    const { node } = result.objectId ? await send("DOM.describeNode", { objectId: result.objectId }) : { node: undefined };
    if (node?.nodeName !== "IFRAME") return page;
    const url = findFrame(frameTree, node.frameId)?.url ?? targets.find((t) => t.id === node.frameId)?.url;
    if (!url) throw new Error("The focused field is in a frame whose site can't be told.");
    return site(url) === page ? page : `${page}, in a frame from ${site(url)}`;
  }
  return { send, evaluate, where, close: () => ws.close() };
}

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
type Frame = { frame: { id: string; url: string }; childFrames?: Frame[] };
const site = (url: string) => new URL(url).host || new URL(url).protocol;
const findFrame = (tree: Frame, id: string): Frame["frame"] | undefined =>
  tree.frame.id === id ? tree.frame : tree.childFrames?.map((c) => findFrame(c, id)).find(Boolean);

const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const label = el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "";
  return { tag: el.tagName, type: el.type ?? "", label, editable: el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test(el.tagName) };
})()`;

// Picks a native <select>'s option by value or text, so "07" matches "7" and "2027" matches "27".
const SELECT = (value: string) => `((value) => {
  const el = document.activeElement;
  const norm = (s) => s.trim().toLowerCase().replace(/^0+(?=\\d)/, "");
  const v = norm(value);
  const same = (t) => { const n = norm(t); return n === v || n.slice(-2) === v || v.slice(-2) === n; };
  const option = [...el.options].find((o) => same(o.value) || same(o.text));
  if (!option) return false;
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})(${JSON.stringify(value)})`;

// Types values into the focused page's focused input, Tab between each, over Chrome DevTools at `browser`. `approve`
// is asked first with the site typing would go to (values are read after it, so a 2FA code is fresh); every value goes
// there or none does. Returns what each went into, never the values.
export async function fill(browser: string, values: () => string[], approve: (where: string) => Promise<boolean> = async () => true) {
  const targets = (await (await fetch(`${browser}/json/list`)).json()) as Target[];
  const sessions = await Promise.all(targets.filter((t) => t.type === "page").map((p) => devtools(p.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, browser.replace(/^http/, "ws")))));
  try {
    const focused = await Promise.all(sessions.map((s) => s.evaluate("document.hasFocus()")));
    const page = sessions[focused.indexOf(true)] ?? (sessions.length === 1 ? sessions[0] : undefined);
    if (!page) throw new Error(sessions.length ? "No tab has focus: click the input first." : "No page is open.");
    const approved = await page.where(targets);
    if (!(await approve(approved))) return undefined;
    const into: string[] = [];
    for (const [i, value] of values().entries()) {
      if (i > 0) for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const now = await page.where(targets);
      if (now !== approved) throw new Error(`Stopped after ${into.length} field(s): typing would now go to ${now}, not ${approved} as approved. Fill fields on different sites in separate calls.`);
      const el = await page.evaluate(FOCUSED);
      if (!el?.editable) throw new Error(`Nothing to type into is focused${i ? ` after ${into.length} field(s)` : ""}: click the input first.`);
      if (el.tag === "SELECT") {
        if (!(await page.evaluate(SELECT(value)))) throw new Error(`No option in "${el.label}" matches the saved value.`);
      } else {
        await page.evaluate("document.activeElement.select?.()");
        await page.send("Input.insertText", { text: value });
      }
      into.push(`${el.tag.toLowerCase()}${el.type ? `[${el.type}]` : ""}${el.label ? ` "${el.label}"` : ""}`);
    }
    return into;
  } finally {
    for (const s of sessions) s.close();
  }
}

export default {
  prompt: `Vault: \`vault_list\` shows the saved logins, cards and licenses: their fields, and non-secret values like
usernames. You never see secret values: a task types them into the page itself (\`vault_fill\`), so for a login or
checkout, start a task and name the vault entry in its goal. To save a new one, \`vault_request\` gives a one-time form
link; if the user pastes a secret in chat anyway, \`vault_save\` it. For a password reset or a new account, start a
task and tell it to set the password with \`vault_new_password\` (naming the entry): the vault makes it, types it and
keeps it. Never text a password; if the user wants to see one, they can look it up on their own devices.`,

  async tools(ctx) {
    const { db } = ctx;
    const save = (name: string, value: Record<string, string>) => {
      const row = { name, fields: Object.keys(value), value };
      db.insert(vault).values(row).onConflictDoUpdate({ target: vault.name, set: row }).run();
    };

    // One-time forms, served only once one has been asked for.
    const forms = new Map<string, { name: string; fields: string[] }>();
    let server: Server | undefined;
    const serve = () => (server ??= createServer(async (req, res) => {
      const token = req.url?.slice(1) ?? "";
      const pending = forms.get(token);
      if (!pending) return void res.writeHead(404).end("This link has expired.");
      if (req.method !== "POST") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(form(pending.name, pending.fields));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      forms.delete(token);
      save(pending.name, Object.fromEntries(pending.fields.map((f) => [f, body.get(`f:${f}`) ?? ""])));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p style='font:17px system-ui'>Saved.</p>");
      void ctx.deliver(`"${pending.name}" was saved to the vault by the user.`);
    }).listen(Number(process.env.VAULT_PORT ?? PORT), "127.0.0.1"));

    const list: LocalTool = {
      name: "vault_list",
      description: "List saved secrets (logins, cards, licenses): their names, fields, and non-secret values like usernames.",
      input: { type: "object", properties: {} },
      async run() {
        const rows = db.select().from(vault).orderBy(vault.name).all();
        if (!rows.length) return text("No secrets saved.");
        const field = (f: string, value = "") => (isPublic(f) && value ? `${f} (${value})` : f);
        return text(rows.map((r) => `${r.name}: ${r.fields.map((f) => field(f, r.value[f])).join(", ")}`).join("\n"));
      },
    };
    const fillTool: LocalTool = {
      name: "vault_fill",
      description:
        "Type saved values into the page without seeing them. Click the first input (e.g. the username box), then call this; several fields are typed in order with Tab between, e.g. ['username', 'password'] or ['number', 'expiry', 'cvc']. The field 'totp' types the current 2FA code. Waits for the owner's approval.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "The entry's name, from vault_list." },
          fields: { type: "array", items: { type: "string" } },
          why: { type: "string", description: "What it's for, shown to the owner when they're asked, e.g. 'checkout for 2 train tickets, $34'." },
        },
        required: ["name", "fields", "why"],
      },
      async run({ name, fields, why }, { slot }) {
        const row = db.select().from(vault).where(eq(vault.name, name as string)).get();
        if (!row) return text(`No secret named "${name}".`);
        const missing = (fields as string[]).filter((f) => !row.value[f]);
        if (missing.length) return text(`"${row.name}" has no ${missing.join(", ")}; it has ${row.fields.join(", ")}.`);
        const approve = (where: string) => ctx.ask(`A task wants to type "${row.name}" (${(fields as string[]).join(", ")}) into ${where}, for ${String(why).slice(0, 200)}. Is ${where} the right site?`);
        const values = () => (fields as string[]).map((f) => (f === "totp" ? totp(row.value[f]) : row.value[f]));
        try {
          const into = await fill(browser(slot), values, approve);
          if (!into) return declined;
          return text(`Typed ${(fields as string[]).join(", ")} into: ${into.join(", ")}. Check the page before submitting.`);
        } catch (err) {
          return text(`Couldn't fill: ${(err as Error).message}`);
        }
      },
    };
    const saveTool: LocalTool = {
      name: "vault_save",
      description: "Save a secret the user typed in chat (so it needn't be typed again), or replace one's values. For new ones, prefer vault_request.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'Delta login'." },
          values: { type: "object", additionalProperties: { type: "string" }, description: "e.g. { username, password }." },
        },
        required: ["name", "values"],
      },
      async run({ name, values }) {
        save(name as string, values as Record<string, string>);
        return text(`Saved "${name}".`);
      },
    };
    const request: LocalTool = {
      name: "vault_request",
      description: "Get a one-time link to a form where the user enters a new secret (or replaces one). Text the link; you'll get a message once it's saved.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'Chase Sapphire card' or 'Delta login'." },
          fields: { type: "array", items: { type: "string" }, description: "e.g. ['number', 'expiry', 'cvc', 'name on card'], ['username', 'password'], or 'totp' for a 2FA setup key." },
        },
        required: ["name", "fields"],
      },
      async run({ name, fields }) {
        serve();
        const token = randomBytes(16).toString("hex");
        forms.set(token, { name: name as string, fields: fields as string[] });
        setTimeout(() => forms.delete(token), FORM_TTL_MS);
        return text(`${process.env.VAULT_URL ?? `https://${ctx.env("TAILNET_HOST")}:9443`}/${token}`);
      },
    };
    const newPasswordTool: LocalTool = {
      name: "vault_new_password",
      description:
        "Set a new password (a reset, or a new account) without seeing it: the vault makes a strong one, types it into the focused input and saves it to the entry, keeping the old one as 'previous password'. Click the new-password input first; with confirm, it's typed again in the next field (Tab) too. Never make up or type a password yourself. Waits for the owner's approval.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "The vault entry, from vault_list, or a new one, e.g. 'Delta login'." },
          username: { type: "string", description: "For a new account: the username or email it's for." },
          confirm: { type: "boolean", description: "Type it in the next field too, for a 'confirm password' box." },
          why: { type: "string", description: "Shown to the owner, e.g. 'resetting the Delta password, which expired'." },
        },
        required: ["name", "why"],
      },
      async run({ name, username, confirm, why }, { slot }) {
        const row = db.select().from(vault).where(eq(vault.name, name as string)).get();
        const password = newPassword();
        const approve = (where: string) =>
          ctx.ask(`A task wants to set a new password for "${name}" on ${where}, for ${String(why).slice(0, 200)}. biscotti makes it, types it and saves it to the vault; it's never texted. Is ${where} the right site?`);
        try {
          const into = await fill(browser(slot), () => (confirm ? [password, password] : [password]), approve);
          if (!into) return declined;
          const old = row?.value.password;
          save(name as string, { ...row?.value, ...(username ? { username: String(username) } : {}), ...(old ? { "previous password": old } : {}), password });
          return text(`Typed a new password into ${into.join(", ")} and saved it to "${name}". Submit the form and check it took; if it didn't, the old one is the entry's "previous password".`);
        } catch (err) {
          return text(`Couldn't set it: ${(err as Error).message}`);
        }
      },
    };
    return { ...localTools([list, saveTool, request]), tasks: localTools([list, fillTool, newPasswordTool]) };
  },
} satisfies Plugin;
