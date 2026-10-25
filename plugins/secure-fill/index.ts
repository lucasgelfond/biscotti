import { createHmac, randomInt } from "node:crypto";
import { bool, declined, input, list, localTools, optional, saveSecret, secret, str, text, type LocalTool, type Plugin } from "@biscotti/core";

// Types vault values into a task VM's page, over Chrome DevTools: no model ever sees them. Asks the owner first, naming
// the site the typing would go to.

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

// A yes for an entry covers the rest of that task's typing of it into the same site, for this long: a card's number,
// expiry and code, even in separate fields or frames, are one yes. Another task, entry or site asks again.
const APPROVAL_MS = 15 * 60_000;
const FRAMED = ", in a frame from ";

// The slot's VM's Chromium, over DevTools (also the screenshots plugin's).
export const browser = (slot?: number) => process.env.TASK_BROWSER ?? `http://10.200.${slot}.2:9223`;

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
export const targets = async (browser: string) => (await (await fetch(`${browser}/json/list`)).json()) as Target[];

export async function devtools(browser: string, target: Target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, browser.replace(/^http/, "ws")));
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
  return { send, close: () => ws.close() };
}

// A tab, with scripts run in a world of their own, where the page's scripts can't change what they see (a faked
// hasFocus).
async function tab(browser: string, target: Target, all: Target[]) {
  const { send, close } = await devtools(browser, target);
  const { frameTree } = await send("Page.getFrameTree");
  const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "biscotti" });
  const evaluate = async (expression: string, byValue = true) => {
    const { result } = await send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: byValue });
    return byValue ? result.value : result;
  };
  // Where typing would go: the tab's site, and the frame's when the focused field is in one.
  async function where() {
    const { frameTree } = await send("Page.getFrameTree");
    const page = site(frameTree.frame.url);
    const { objectId } = await evaluate("document.activeElement", false);
    const { node } = objectId ? await send("DOM.describeNode", { objectId }) : { node: undefined };
    if (node?.nodeName !== "IFRAME") return page;
    const url = findFrame(frameTree, node.frameId)?.url ?? all.find((t) => t.id === node.frameId)?.url;
    if (!url) throw new Error("The focused field is in a frame whose site can't be told.");
    return site(url) === page ? page : `${page}${FRAMED}${site(url)}`;
  }
  return { send, evaluate, where, close };
}

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
export async function fill(browser: string, values: () => string[], approve: (where: string) => Promise<boolean>) {
  const all = await targets(browser);
  const tabs = await Promise.all(all.filter((t) => t.type === "page").map((t) => tab(browser, t, all)));
  try {
    const focused = await Promise.all(tabs.map((t) => t.evaluate("document.hasFocus()")));
    const page = tabs[focused.indexOf(true)] ?? (tabs.length === 1 ? tabs[0] : undefined);
    if (!page) throw new Error(tabs.length ? "No tab has focus: click the input first." : "No page is open.");
    const approved = await page.where();
    if (!(await approve(approved))) return undefined;
    const into: string[] = [];
    for (const [i, value] of values().entries()) {
      if (i > 0) for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const now = await page.where();
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
    for (const t of tabs) t.close();
  }
}

export default {
  prompt: `Secure fill: a task types vault values into the page itself (\`vault_fill\`), so for a login or checkout,
start a task and name the vault entry in its goal. For a password reset or a new account, start a task and tell it to
set the password with \`vault_new_password\` (naming the entry): the vault makes it, types it and keeps it.`,

  async tools(ctx) {
    const { db } = ctx;
    // Types `values` once the owner says yes to `question` about where they'd go; `done` says what was typed.
    const typeIn = (slot: number | undefined, values: () => string[], approve: (where: string) => Promise<boolean>, done: (into: string[]) => string) =>
      fill(browser(slot), values, approve)
        .then((into) => (into ? text(done(into)) : declined))
        .catch((err: Error) => text(`Couldn't fill: ${err.message}`));

    // Per task and entry: the sites the owner said yes to, until when. A yes for a frame on a page covers the page's
    // own fields too; a yes for the page alone doesn't cover a frame from another site.
    const approvals = new Map<string, { sites: Set<string>; until: number }>();
    function approver(task: number | undefined, entry: string, question: (where: string) => string) {
      const key = task && `${task}\n${entry}`;
      return async (where: string) => {
        for (const [k, a] of approvals) if (a.until <= Date.now()) approvals.delete(k);
        const approval = key && approvals.get(key);
        if (approval && approval.sites.has(where)) return true;
        const covers = key ? ` A yes covers the rest of this task's typing of "${entry}" there, for ${APPROVAL_MS / 60_000} minutes.` : "";
        if (!(await ctx.ask(question(where) + covers))) return false;
        if (key) {
          const granted = approval || { sites: new Set<string>(), until: Date.now() + APPROVAL_MS };
          granted.sites.add(where).add(where.split(FRAMED)[0]);
          approvals.set(key, granted);
        }
        return true;
      };
    }
    const fillTool: LocalTool = {
      name: "vault_fill",
      description:
        "Type saved values into the page without seeing them. Click the first input (e.g. the username box), then call this; several fields are typed in order with Tab between, e.g. ['username', 'password'] or ['number', 'expiry', 'cvc']. The field 'totp' types the current 2FA code. Waits for the owner's approval; their yes covers the rest of this task's fills of the entry on that site.",
      input: input({
        name: str("The entry's name, from vault_list."),
        fields: list(str()),
        why: str("What it's for, shown to the owner when they're asked, e.g. 'checkout for 2 train tickets, $34'."),
      }),
      async run({ name, fields, why }, { slot, task }) {
        const [entry, wanted] = [String(name), fields as string[]];
        const saved = secret(db, entry);
        if (!saved) return text(`No secret named "${entry}".`);
        const missing = wanted.filter((f) => !saved[f]);
        if (missing.length) return text(`"${entry}" has no ${missing.join(", ")}; it has ${Object.keys(saved).join(", ")}.`);
        const values = () => wanted.map((f) => (f === "totp" ? totp(saved[f]) : saved[f]));
        const question = (where: string) => `A task wants to type "${entry}" (${wanted.join(", ")}) into ${where}, for ${String(why).slice(0, 200)}. Is ${where} the right site?`;
        return typeIn(slot, values, approver(task, entry, question), (into) => `Typed ${wanted.join(", ")} into: ${into.join(", ")}. Check the page before submitting.`);
      },
    };
    const newPasswordTool: LocalTool = {
      name: "vault_new_password",
      description:
        "Set a new password (a reset, or a new account) without seeing it: the vault makes a strong one, types it into the focused input and saves it to the entry, keeping the old one as 'previous password'. Click the new-password input first; with confirm, it's typed again in the next field (Tab) too. When the owner's request spells out the password they want, pass it as password and that one is used. Never make up or type a password yourself. Waits for the owner's approval.",
      input: input({
        name: str("The vault entry, from vault_list, or a new one, e.g. 'Delta login'."),
        username: optional(str("For a new account: the username or email it's for.")),
        confirm: optional(bool("Type it in the next field too, for a 'confirm password' box.")),
        password: optional(str("Only the password the owner's own request spells out, exactly; leave it out otherwise.")),
        why: str("Shown to the owner, e.g. 'resetting the Delta password, which expired'."),
      }),
      async run({ name, username, confirm, password: chosen, why }, { slot, asked }) {
        const entry = String(name);
        const saved = secret(db, entry);
        // A password the owner chose must be in what they asked: one from a page or an email would be known to whoever wrote it.
        if (chosen !== undefined && !(String(chosen) && asked?.includes(String(chosen))))
          return text("That password isn't in the owner's request, so it can't be used. Leave password out and the vault makes one.");
        const password = chosen === undefined ? newPassword() : String(chosen);
        const question = (where: string) =>
          `A task wants to set a new password for "${entry}" on ${where}, for ${String(why).slice(0, 200)}. ${chosen === undefined ? "biscotti makes it" : "It's the one you asked for; biscotti"} types it and saves it to the vault; it's never texted. Is ${where} the right site?`;
        return typeIn(slot, () => (confirm ? [password, password] : [password]), (where) => ctx.ask(question(where)), (into) => {
          const old = saved?.password;
          saveSecret(db, entry, { ...saved, ...(username ? { username: String(username) } : {}), ...(old ? { "previous password": old } : {}), password });
          return `Typed a new password into ${into.join(", ")} and saved it to "${entry}". Submit the form and check it took; if it didn't, the old one is the entry's "previous password".`;
        });
      },
    };
    // Only task VMs fill pages; the main agent starts a task for it.
    return { ...localTools([]), tasks: localTools([fillTool, newPasswordTool]) };
  },
} satisfies Plugin;
