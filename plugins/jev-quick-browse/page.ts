// A Chromium tab over DevTools: what's on screen as labelled elements (with what each field holds) and text, and real
// input events. A password, card or one-time-code field's value is never read out, only whether it's filled.

export interface Element {
  // The same element keeps its number across reads of the page (until it navigates).
  i: number;
  tag: string;
  role: string;
  text: string;
  href?: string;
  field: boolean;
  secret: boolean;
  covered: boolean;
  // Just below the fold: scrolled to when it's clicked.
  offscreen?: boolean;
  // What a field holds ("(hidden)" for a filled secret one), or a dropdown's chosen option.
  value?: string;
  // Checked, expanded, selected, required, invalid…, and a native <select>'s options.
  state?: string;
  options?: string[];
  // For a label others share: the nearest one before it that appears once.
  near?: string;
  // The open dialog or list it's in ("Choose a date"), when one is open.
  in?: string;
}

export type Rect = { x: number; y: number; w: number; h: number };

export interface Page {
  url: string;
  title: string;
  elements: Element[];
  // Visible text that isn't a control, block by block in page order (only a modal dialog's, while one is open), and
  // the page's error and validation messages.
  text: string[];
  alerts: string[];
  // The open dialog's name, and how many suggestions or list options are showing.
  dialog?: string;
  suggestions: number;
  canScroll: boolean;
  canGoBack: boolean;
  // Drawings the DOM can't read (a canvas seat map, an SVG map), big enough to matter: where they are, largest first.
  pictures: Rect[];
  // A seat map's legend, read from its swatches: the color of open, selected and taken seats.
  legend: { open?: string; selected?: string; taken?: string };
}

// Elements are found again by number through window.__dcu, a node-to-number WeakMap kept across reads (as
// jev-ultrafast's snapshot.js keeps its ids), so "element 12" means the same button from one step to the next.
// `words` are the goal's, to rank by; `max` caps the elements.
const PERCEIVE = `((words, max) => {
  const W = window.__dcu ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const id = (el) => { if (!W.ids.has(el)) W.ids.set(el, W.next++); const i = W.ids.get(el); W.nodes.set(i, el); return i; };
  for (const [i, el] of W.nodes) if (!el.isConnected) W.nodes.delete(i);
  // One tab: a link or pop-up that would open another opens here instead.
  document.querySelectorAll("a[target]").forEach((a) => (a.target = "_self"));
  window.open = (url) => (url && location.assign(url), window);
  const ROLES = /^(button|link|menuitem\\w*|tab|checkbox|radio|switch|combobox|option|gridcell|treeitem|searchbox|textbox|slider|spinbutton)$/;
  const TEXT_TYPES = /^(text|search|email|url|tel|number|password|date|datetime-local|month|week|time)$/;
  const SECRET = /(^|\\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp\\S*)(\\s|$)/;
  const SECRET_LABEL = /pass(word|code)|\\bpin\\b|cvc|cvv|card number|security code|one-time|\\bssn\\b/i;
  const vw = innerWidth, vh = innerHeight, fold = vh * 1.6;
  const onScreen = (r) => r.width > 1 && r.height > 1 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
  const nearScreen = (r) => r.width > 1 && r.height > 1 && r.top < fold && r.bottom > 0 && r.left < vw && r.right > 0;
  const shown = (el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const textOf = (el) => clean(el.innerText ?? el.textContent);
  // What a dialog, list or form section is called: its label, else its first heading.
  const nameOf = (el) => clean(el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(/\\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ")
    || el.querySelector("h1,h2,h3,h4,legend,[role=heading]")?.textContent || "").slice(0, 60);
  // An open dialog (the topmost), else an open list of options: what the page is waiting on.
  const dialogs = [...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")]
    .filter((d) => d.getAttribute("aria-hidden") !== "true" && shown(d) && onScreen(d.getBoundingClientRect()));
  const dialog = dialogs.at(-1);
  // A modal one (not a cookie banner along the bottom) hides the page behind it, so its text is the page's.
  const modal = !!dialog && (dialog.matches("[aria-modal=true]") || (() => { try { return dialog.matches(":modal"); } catch { return false; } })()
    || (() => { const r = dialog.getBoundingClientRect(); return r.width * r.height > 0.35 * vw * vh; })());
  const isOption = (o) => !o.closest("select") && shown(o) && onScreen(o.getBoundingClientRect());
  const listOptions = [...document.querySelectorAll("[role=option], [role=listbox] li, [role=menu] [role^=menuitem]")].filter(isOption);
  const list = listOptions[0]?.closest("[role=listbox],[role=menu],[role=grid],ul");
  const popup = dialog || list;
  const popupName = dialog ? nameOf(dialog) || "dialog" : list ? nameOf(list) || "suggestions" : "";
  const CONTROLS = "a,button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable=true]";
  // What already takes the click for anything inside it (not a role=main or role=dialog wrapper).
  const CLICKABLE = "a,button,input,select,textarea,summary,[onclick],[role=button],[role=link],[role=option],[role=gridcell],[role=tab],[role^=menuitem],[role=checkbox],[role=radio],[role=switch]";
  const LABEL = (el) => {
    const by = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ");
    return clean(by) || el.getAttribute("aria-label") || (el.labels && el.labels[0] ? textOf(el.labels[0]) : "") || "";
  };
  // Plus what only a script makes clickable (a showtime drawn as a <div>, a calendar day, a seat drawn in SVG): short
  // text, a label or a pointer cursor, inside no control.
  const pointers = [];
  let scanned = 0;
  for (const el of document.querySelectorAll("div,span,li,td,p,label,img,svg,rect,circle,ellipse,path,polygon,g")) {
    if (++scanned > 6000) break;
    const r = el.getBoundingClientRect();
    if (!nearScreen(r) || r.width > 400 || el.closest(CLICKABLE)) continue;
    const svg = el instanceof SVGElement && el.tagName.toLowerCase() !== "svg";
    const named = el.getAttribute("aria-label") || (svg && (el.querySelector(":scope > title")?.textContent || el.getAttribute("title")));
    const pointer = getComputedStyle(el).cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer");
    if (svg ? named && (pointer || el.getAttribute("aria-label")) : (pointer || (named && el.getAttribute("tabindex") !== null))) {
      const t = clean(named || el.innerText || el.getAttribute("alt") || el.textContent);
      if (t.length > 0 && t.length <= 80) pointers.push(el);
    }
  }
  const pointerSet = new Set(pointers);
  const goal = new Set(words);
  const matchesGoal = (t) => t.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 2 && goal.has(w));
  const found = [], seen = new Set(), links = new Set();
  for (const el of [...document.querySelectorAll(CONTROLS), ...pointers]) {
    const r = el.getBoundingClientRect();
    if (!nearScreen(r) || el.disabled || el.closest("[aria-hidden=true],[inert],[aria-disabled=true]") || !shown(el)) continue;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const tag = el.tagName.toLowerCase();
    const native = /^(a|button|input|select|textarea|summary)$/.test(tag);
    if (!native && !ROLES.test(role) && !el.onclick && !el.hasAttribute("tabindex") && !el.isContentEditable && !pointerSet.has(el)) continue;
    if (role === "gridcell" && el.querySelector("button,[role=button],a")) continue;
    const type = tag === "input" ? (el.type || "text").toLowerCase() : "";
    if (type === "hidden" || type === "file") continue;
    const field = tag === "textarea" || (tag === "input" && TEXT_TYPES.test(type)) || (el.isContentEditable && !native) || role === "textbox" || role === "searchbox";
    let text = LABEL(el) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "";
    if (!text && el instanceof SVGElement) text = el.querySelector(":scope > title")?.textContent || "";
    if (!text && !field) text = el.innerText ?? el.textContent ?? "";
    if (!text && /^(submit|button|reset)$/.test(type)) text = el.value;
    text = clean(text || el.getAttribute("name") || "").slice(0, 120);
    const key = text + "|" + Math.round(r.left) + "|" + Math.round(r.top);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    // A link that says and goes the same as one already listed adds nothing.
    const href = tag === "a" && el.href ? el.href.slice(0, 120) : undefined;
    if (href) { if (links.has(text + "|" + href)) continue; links.add(text + "|" + href); }
    const secret = type === "password" || SECRET.test((el.getAttribute("autocomplete") || "").toLowerCase()) || (field && SECRET_LABEL.test(text));
    const raw = field ? String(el.value ?? el.innerText ?? "") : "";
    const value = tag === "select" ? (el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex].text) : "")
      : field ? (secret ? (raw ? "(hidden)" : "") : clean(raw).slice(0, 80))
      : role === "combobox" ? textOf(el).slice(0, 80) : undefined;
    const x = r.left + Math.min(r.width, 1400) / 2, y = r.top + r.height / 2;
    const top = onScreen(r) ? document.elementFromPoint(Math.min(Math.max(x, 0), vw - 1), Math.min(Math.max(y, 0), vh - 1)) : null;
    const invalid = el.getAttribute("aria-invalid") === "true" || (field && raw && el.validity && !el.validity.valid);
    const state = [el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "", el.getAttribute("aria-expanded") === "true" ? "expanded" : "",
      el.getAttribute("aria-selected") === "true" || (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") ? "selected" : "",
      el.getAttribute("aria-pressed") === "true" ? "pressed" : "", field ? (raw ? "filled" : "empty") : "",
      el.required || el.getAttribute("aria-required") === "true" ? "required" : "", invalid ? "invalid" : "", el.readOnly ? "read-only" : ""].filter(Boolean).join(", ");
    const inPopup = !!popup && popup.contains(el);
    // Rank: what an open dialog or list holds, then fields and dropdowns, then what the goal names, then buttons and
    // the like, links last; on screen before just below it, then top to bottom.
    const rank = inPopup ? 0 : field || tag === "select" || role === "combobox" ? 1 : matchesGoal(text) ? 2 : href || role === "link" ? 4 : 3;
    found.push({ el, rank, below: !onScreen(r), y: r.top, x: r.left, e: {
      tag: tag + (role ? "[" + role + "]" : type ? "[" + type + "]" : ""),
      role: role || (tag === "a" ? "link" : tag === "select" ? "select" : field ? "textbox" : /^(checkbox|radio)$/.test(type) ? type : tag === "button" || /^(submit|button|reset|image)$/.test(type) || tag === "summary" ? "button" : "clickable"),
      text, href, field, secret, covered: !!top && !el.contains(top) && !top.contains(el),
      offscreen: !onScreen(r) || undefined, value: value || undefined, state: state || undefined,
      options: tag === "select" ? [...el.options].slice(0, 40).map((o) => clean(o.text)) : undefined,
      in: inPopup ? popupName : undefined,
    } });
  }
  found.sort((a, b) => a.rank - b.rank || Number(a.below) - Number(b.below) || (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
  found.splice(max);
  for (const o of found) o.e.i = id(o.el);
  // Three "Add to cart" buttons say nothing about which is which; each one's card (the smallest ancestor holding only
  // that one) does, by its first line, such as the product's name.
  const count = new Map();
  for (const o of found) count.set(o.e.text, (count.get(o.e.text) || 0) + 1);
  for (const o of found) {
    if (count.get(o.e.text) < 2 || o.e.in) continue;
    for (let p = o.el.parentElement, up = 0; p && up < 8; p = p.parentElement, up++) {
      if (found.filter((x) => x.e.text === o.e.text && p.contains(x.el)).length > 1) break;
      const first = (p.innerText || "").split("\\n").map((l) => l.trim()).find((l) => l && l !== o.e.text);
      if (first) { o.e.near = first.slice(0, 80); break; }
    }
  }
  // Visible text that isn't a control (prices, dates, errors), as blocks: evidence, never a click target. With a dialog
  // open, only its text. No field's value is read here.
  const labels = new Set(found.map((o) => o.e.text.toLowerCase()));
  const text = [], alerts = [], blocks = new Set();
  const ALERT = "[role=alert],[aria-live=assertive],[aria-live=polite],[aria-invalid=true]";
  const walker = document.createTreeWalker((modal && dialog) || document.body || document, NodeFilter.SHOW_TEXT);
  const INLINE = /^(B|STRONG|I|EM|U|SMALL|SPAN|CODE|MARK|SUB|SUP|ABBR|A|LABEL|TIME|DATA|BR|S|DEL|INS|Q|CITE)$/;
  // A block's own words: its text and inline children's, not a nested block's (that one is a block of its own).
  const own = (block) => clean([...block.childNodes].map((c) => c.nodeType === 3 ? c.textContent : c.nodeType === 1 && INLINE.test(c.tagName) ? " " + own(c) + " " : " ").join(""));
  for (let n; (n = walker.nextNode()) && text.length < 400; ) {
    const p = n.parentElement;
    if (!n.textContent.trim() || !p || p.closest("script,style,noscript,template,title,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[aria-hidden=true]")) continue;
    let block = p;
    while (block.parentElement && INLINE.test(block.tagName)) block = block.parentElement;
    if (blocks.has(block) || !nearScreen(block.getBoundingClientRect()) || !shown(block)) continue;
    blocks.add(block);
    const t = own(block).slice(0, 300);
    if (t.length < 2 || labels.has(t.toLowerCase())) continue;
    const cls = typeof block.className === "string" ? block.className : "";
    if (block.closest(ALERT) || /error|invalid|warning|alert/i.test(cls)) alerts.push(t.slice(0, 200));
    else text.push(t);
  }
  // Behind a modal too: an error is what the page is saying.
  for (const el of document.querySelectorAll(ALERT)) {
    const t = textOf(el);
    if (t.length > 1 && t.length <= 200 && shown(el) && nearScreen(el.getBoundingClientRect())) alerts.push(t);
  }
  // A legend's swatch is a small colored box beside its words ("Available", "Selected", "Sold").
  const NAMES = { green: [40, 160, 70], blue: [30, 80, 220], "light blue": [120, 180, 240], red: [210, 40, 40], orange: [240, 140, 30],
    yellow: [240, 210, 40], purple: [130, 60, 180], pink: [230, 120, 180], grey: [170, 170, 170], "dark grey": [90, 90, 90], white: [250, 250, 250], black: [20, 20, 20] };
  const named = (css) => { const m = css.match(/\\d+/g); if (!m || css.includes("rgba") && m[3] === "0") return undefined; const [r, g, b] = m.map(Number);
    return Object.entries(NAMES).sort(([, p], [, q]) => (p[0]-r)**2+(p[1]-g)**2+(p[2]-b)**2 - ((q[0]-r)**2+(q[1]-g)**2+(q[2]-b)**2))[0][0]; };
  const swatch = (el) => { for (const s of [el.previousElementSibling, el.firstElementChild, el.parentElement?.firstElementChild]) { if (!s || s === el) continue; const r = s.getBoundingClientRect();
    if (r.width > 4 && r.width < 48 && r.height > 4 && r.height < 48) return named(getComputedStyle(s).backgroundColor) ?? named(getComputedStyle(s).borderColor) ?? named(getComputedStyle(s).fill || ""); } };
  const legend = {};
  for (const el of document.querySelectorAll("body *")) {
    const t = el.childElementCount <= 1 ? (el.textContent || "").trim().toLowerCase() : "";
    const kind = /^(available|open)( seats?)?$/.test(t) ? "open" : /^(selected|your seats?)$/.test(t) ? "selected" : /^(taken|sold|unavailable|occupied|reserved)( seats?)?$/.test(t) ? "taken" : "";
    if (kind && !legend[kind]) legend[kind] = swatch(el);
  }
  const sc = document.scrollingElement || document.documentElement;
  const pictures = [...document.querySelectorAll("canvas,svg,img,iframe")].map((el) => [el, el.getBoundingClientRect()])
    .filter(([el, r]) => onScreen(r) && r.width >= 200 && r.height >= 150 && shown(el))
    .map(([, r]) => ({ x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(r.right, vw) - Math.max(0, r.left), h: Math.min(r.bottom, vh) - Math.max(0, r.top) }))
    .sort((a, b) => b.w * b.h - a.w * a.h);
  return { url: location.href, title: document.title, elements: found.map((o) => o.e), text, alerts: [...new Set(alerts)].slice(0, 10),
    dialog: dialog ? popupName : undefined, suggestions: listOptions.length, pictures, legend,
    canScroll: sc.scrollHeight > vh + 4, canGoBack: history.length > 1 };
})`;

// Jev takes pictures 280 to 1568 pixels a side, never resized for us; aim inside that, with room to spare.
const LO = 300;
const HI = 1500;
// The CSS-pixel scale that makes a w x h area (in CSS pixels) come out between LO and HI pixels a side on a screen of
// `dpr` device pixels per CSS pixel. CDP's captureScreenshot multiplies the clip's scale by the device pixel ratio.
export function scaleFor(w: number, h: number, dpr = 1) {
  return Math.min(HI / (Math.max(w, h) * dpr), Math.max(LO / (Math.min(w, h) * dpr), 1));
}
// A PNG's width and height, from its header (bytes 16 to 23), to check before sending it.
export function pngSize(base64: string) {
  const head = Buffer.from(base64.slice(0, 32), "base64");
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

// The words of a goal that say what it's about. Besides grammar, the words that say what KIND of thing is wanted
// ("open the article about X") match the wrong rows (stop list after lexmount/jev-browser-bridge's evidence.py).
const STOP = new Set(
  ("a an the of in on at to for is are was were be by with from and or as it its this that what which how many much do does did can could " +
    "should would will your you my me open find go click type select search report page article link linked about here then there into get " +
    "show tell give make sure any all some one").split(" "),
);
export const keywords = (text: string) => [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length > 2 && !STOP.has(w));

// Facts a decision turns on: prices, times, dates, counts.
const FACT = /[$€£¥]\s?\d|\d\s?(%|usd|eur)|\b\d{1,2}:\d{2}\b|\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d|\b\d+\s?(results?|items?|seats?|left|available|stops?|nights?|reviews?)\b/i;

// The page's text blocks that bear on `words`, in page order, within `budget` characters: the jev-browser-bridge
// evidence.py ranking (rare words count most, a number makes a block likelier a fact, and a hit keeps the block
// before and the two after, where a label's value usually is), plus blocks with prices, times or dates kept even
// without a hit; slack goes to the page's first blocks.
export function relevant(blocks: string[], words: string[], budget = 5000) {
  const all = blocks.join("\n");
  if (all.length <= budget) return all;
  const low = blocks.map((b) => b.toLowerCase());
  const n = blocks.length;
  const idf = Object.fromEntries(words.map((w) => [w, Math.log(n / Math.max(1, low.filter((t) => t.includes(w)).length)) + 0.1]));
  const ranked = low
    .map((t, i) => {
      let score = words.reduce((s, w) => s + (t.includes(w) ? idf[w] : 0), 0);
      if (FACT.test(t)) score = (score || 0.5) * 1.5;
      else if (/\d/.test(t)) score *= 1.4;
      return { score, i };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  const add = (j: number) => !keep.has(j) && used + blocks[j].length + 1 <= budget && (keep.add(j), (used += blocks[j].length + 1));
  for (const { i } of ranked) {
    if (used >= budget) break;
    add(i);
    for (const j of [i - 1, i + 1, i + 2]) if (j >= 0 && j < n && used < budget * 0.85) add(j);
  }
  for (let i = 0; i < n && used < budget; i++) add(i);
  return [...keep].sort((a, b) => a - b).map((i) => blocks[i]).join("\n");
}

// Today and the next two months, so "next Friday" and a calendar's paging come out right (fastbrowse puts the date in
// each observation for the same reason).
export function today(now = new Date()) {
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const later = [1, 2].map((k) => month(new Date(now.getFullYear(), now.getMonth() + k, 1)));
  return `${iso} (${now.toLocaleDateString("en-US", { weekday: "long" })}); next months: ${later.join(", ")}`;
}

// What an action did, as the next decision should read it: a new address, a dialog opening or closing, the field's
// new value, suggestions to choose from, or nothing at all. `shown` is how a value may be shown (masked or not).
export function effect(before: Page, after: Page, target?: Element, shown: (e: Element) => string | undefined = (e) => e.value) {
  const said: string[] = [];
  if (after.url !== before.url) said.push(`URL changed to ${after.url.slice(0, 100)}`);
  if (after.dialog !== before.dialog) said.push(after.dialog ? `dialog "${after.dialog}" opened` : "dialog closed");
  const now = target && after.elements.find((e) => e.i === target.i);
  if (now && target!.field && now.value !== target!.value) said.push(now.value ? `value now "${shown(now)}"` : "field now empty");
  if (now && now.state !== target!.state && !target!.field) said.push(now.state ? `now ${now.state}` : `no longer ${target!.state}`);
  // Another field it filled (a suggestion picked into its box, a date into its field).
  for (const e of after.elements.filter((e) => e.field && e.i !== target?.i && e.value !== before.elements.find((b) => b.i === e.i)?.value).slice(0, 2))
    if (before.elements.some((b) => b.i === e.i)) said.push(`"${e.text}" now ${e.value ? `"${shown(e)}"` : "empty"}`);
  if (after.suggestions > before.suggestions)
    said.push(`${after.suggestions} suggestions opened: choose one${target?.field ? ", don't type again" : ""}`);
  else if (!after.suggestions && before.suggestions) said.push("the suggestions closed");
  const fresh = after.alerts.filter((a) => !before.alerts.includes(a));
  if (fresh.length) said.push(`the page says "${fresh.join(" / ").slice(0, 160)}"`);
  if (!said.length) said.push(JSON.stringify(after) !== JSON.stringify(before) ? "the page changed" : "nothing changed");
  return said.join("; ");
}

type Target = { type: string; webSocketDebuggerUrl: string };
const MAX_ELEMENTS = 160;

export async function openPage(browser: string) {
  const targets = (await (await fetch(`${browser}/json/list`)).json()) as Target[];
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no browser tab is open");
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, browser.replace(/^http/, "ws")));
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const pending = new Map<number, (msg: { result?: any; error?: { message: string } }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  let id = 0;
  // A page mid-navigation can leave a call unanswered.
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => (pending.delete(n), reject(new Error(`${method} timed out`))), 15_000);
      pending.set(n, (msg) => (clearTimeout(timer), msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression: string) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, timeout: 5_000 });
    if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The goal's words rank the elements; fewer elements when a request ran too long.
  let words: string[] = [];
  let max = MAX_ELEMENTS;
  const read = (): Promise<Page> => evaluate(`${PERCEIVE}(${JSON.stringify(words)}, ${max})`);
  const perceive = async (): Promise<Page> => {
    for (let i = 0; i < 20 && (await evaluate("document.readyState").catch(() => "loading")) === "loading"; i++) await sleep(250);
    // An app that renders after load shows next to nothing at first.
    let page = await read();
    for (let i = 0; i < 10 && page.elements.length + page.text.length < 3; i++) page = (await sleep(500), await read());
    return page;
  };
  const at = (i: number) => `window.__dcu?.nodes.get(${Number(i)})`;
  const key = async (key: string, code: number) => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
  };
  const capture = async (x: number, y: number, w: number, h: number, scale: number) =>
    (await send("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale } })).data as string;

  return {
    perceive,
    // The goal's words, to rank the page's elements by; and how many elements to read.
    rank(goalWords: string[], cap = MAX_ELEMENTS) {
      words = goalWords;
      max = cap;
    },
    async click(i: number) {
      const point = await evaluate(`(() => { const el = ${at(i)}; if (!el || !el.isConnected) return null; el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width, 1400) / 2, y: r.top + r.height / 2 }; })()`);
      if (!point) return false;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      return true;
    },
    // Whether the text landed, by the field's length alone.
    async type(i: number, text: string) {
      if (!(await evaluate(`(() => { const el = ${at(i)}; el?.focus(); el?.select?.(); return !!el && document.activeElement === el; })()`))) return false;
      await send("Input.insertText", { text });
      return evaluate(`(() => { const el = ${at(i)}; return !!el && (el.value ?? el.innerText ?? "").length >= ${text.length}; })()`);
    },
    // A native <select>'s option, by its position, as a person picking it would.
    choose: (i: number, option: number) =>
      evaluate(`(() => { const el = ${at(i)}; if (!el?.options?.[${option}]) return false; el.selectedIndex = ${option};
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`),
    // Until suggestions or list options show (after typing into or opening a combobox), or `ms`.
    async suggestions(ms: number) {
      const count = `[...document.querySelectorAll("[role=option], [role=listbox] li")].filter((o) => !o.closest("select") && o.getBoundingClientRect().height > 0).length`;
      for (let t = 0; t < ms; t += 50) {
        if ((await evaluate(count).catch(() => 0)) > 0) return true;
        await sleep(50);
      }
      return false;
    },
    // A PNG (base64) of part of the viewport (all of it by default), sized for Jev.
    async screenshot(area?: Rect) {
      const view = await evaluate("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 })");
      let { x, y, w, h } = area ?? { x: 0, y: 0, w: view.w, h: view.h };
      // An area too long and thin for both limits (a banner) takes in more around its short side.
      const most = HI / LO;
      if (w > h * most) [y, h] = [Math.max(0, y - (w / most - h) / 2), w / most];
      else if (h > w * most) [x, w] = [Math.max(0, x - (h / most - w) / 2), h / most];
      let scale = scaleFor(w, h, view.dpr);
      let png = await capture(x, y, w, h, scale);
      // Off by a ratio the page didn't report (a zoomed window): rescale by what came out, once.
      const got = pngSize(png);
      if (Math.min(got.w, got.h) < 280 || Math.max(got.w, got.h) > 1568) {
        scale *= Math.min(HI / Math.max(got.w, got.h), Math.max(LO / Math.min(got.w, got.h), 1));
        png = await capture(x, y, w, h, scale);
      }
      return png;
    },
    // The same area at 1:1, to tell whether a click changed what's drawn.
    pixels: async (area: Rect) => (await send("Page.captureScreenshot", { format: "png", clip: { x: area.x, y: area.y, width: area.w, height: area.h, scale: 1 } })).data as string,
    // A click at a point of the viewport, in CSS pixels.
    async clickPoint(x: number, y: number) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    evaluate,
    enter: () => key("Enter", 13),
    escape: () => key("Escape", 27),
    scroll: (down: boolean) => evaluate(`scrollBy(0, ${down ? "" : "-"}innerHeight * 0.8)`),
    back: () => evaluate("history.back()"),
    navigate: (url: string) => send("Page.navigate", { url }),
    // The whole page's text, for the report and the writing model (a field's value isn't part of it).
    fullText: async () => String((await evaluate("document.body?.innerText ?? ''")) ?? "").replace(/\n\s*\n+/g, "\n").slice(0, 15_000),
    // Until the page shows something new, or a little while.
    async settled(before: string) {
      for (let i = 0; i < 12; i++) {
        await sleep(i ? 250 : 150);
        const page = await perceive().catch(() => undefined);
        if (page && JSON.stringify(page) !== before) return page;
      }
      return perceive();
    },
    close: () => ws.close(),
  };
}

export type Tab = Awaited<ReturnType<typeof openPage>>;
