// A Chromium tab over DevTools: what's on screen as labelled elements and text, and real input events. Field values
// are never read, so nothing typed into a page (a password, a card) reaches a model.

export interface Element {
  i: number;
  tag: string;
  text: string;
  href?: string;
  field: boolean;
  secret: boolean;
  covered: boolean;
  // Checked, expanded, selected…, and a native <select>'s options (and which is chosen).
  state?: string;
  options?: string[];
  // For a label others share: the nearest one before it that appears once.
  near?: string;
}

export interface Page {
  url: string;
  title: string;
  elements: Element[];
  text: string[];
  canScroll: boolean;
  canGoBack: boolean;
}

// Each element is stamped data-dcu="<i>" so actions can find it again; the previous stamps are cleared first.
const PERCEIVE = `(() => {
  document.querySelectorAll("[data-dcu]").forEach((el) => el.removeAttribute("data-dcu"));
  const ROLES = /^(button|link|menuitem\\w*|tab|checkbox|radio|switch|combobox|option|searchbox|textbox|slider|spinbutton)$/;
  const TEXT_TYPES = /^(text|search|email|url|tel|number|password)$/;
  const SECRET = /(^|\\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp\\S*)(\\s|$)/;
  const vw = innerWidth, vh = innerHeight;
  const onScreen = (r) => r.width > 1 && r.height > 1 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
  const shown = (el) => { const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const elements = [], seen = new Set();
  const CONTROLS = "a,button,input,select,textarea,summary,[role],[onclick],[tabindex]";
  // Plus what only a script makes clickable (a showtime drawn as a <div>): short on-screen text with a pointer cursor,
  // inside no control.
  const pointers = [...document.querySelectorAll("div,span,li,td,p,label,img,svg")].filter((el) => {
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || r.width > 400 || el.closest(CONTROLS)) return false;
    const t = (el.innerText || el.getAttribute("alt") || el.getAttribute("aria-label") || "").trim();
    return t.length > 0 && t.length <= 60 && getComputedStyle(el).cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer");
  });
  for (const el of [...document.querySelectorAll(CONTROLS), ...pointers]) {
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || el.disabled || el.getAttribute("aria-hidden") === "true" || !shown(el)) continue;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (!/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) && !ROLES.test(role) && !el.onclick && !el.hasAttribute("tabindex") && !pointers.includes(el)) continue;
    const type = el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : "";
    const field = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.test(type));
    const typedInto = field || el.isContentEditable || role === "textbox" || role === "searchbox";
    let text = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "";
    if (!text && !typedInto) text = el.innerText || (/^(submit|button|reset)$/.test(type) ? el.value : "");
    text = (text || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    const key = text + "|" + Math.round(r.left) + "|" + Math.round(r.top);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    const x = r.left + Math.min(r.width, 1400) / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(Math.min(Math.max(x, 0), vw - 1), Math.min(Math.max(y, 0), vh - 1));
    elements.push({ el, y: r.top, x: r.left, e: {
      tag: el.tagName.toLowerCase() + (role ? "[" + role + "]" : type ? "[" + type + "]" : ""), text,
      href: el.tagName === "A" && el.href ? el.href.slice(0, 120) : undefined,
      field, secret: type === "password" || SECRET.test((el.getAttribute("autocomplete") || "").toLowerCase()),
      covered: !!top && !el.contains(top) && !top.contains(el),
      state: [el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "", el.getAttribute("aria-expanded") === "true" ? "expanded" : "",
        el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") ? "selected" : "", el.getAttribute("aria-pressed") === "true" ? "pressed" : "",
        el.tagName === "SELECT" && el.selectedIndex >= 0 ? "chosen: " + el.options[el.selectedIndex].text.trim() : ""].filter(Boolean).join(", ") || undefined,
      options: el.tagName === "SELECT" ? [...el.options].slice(0, 40).map((o) => o.text.trim()) : undefined,
    } });
  }
  elements.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
  elements.splice(120);
  elements.forEach((o, i) => (o.el.setAttribute("data-dcu", i), (o.e.i = i)));
  // Visible text that isn't a control (prices, dates, errors): evidence, never a click target. Nothing typed is read.
  const labels = new Set(elements.map((o) => o.e.text.toLowerCase()));
  const text = [], blocks = new Set();
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()) && text.length < 120; ) {
    const p = n.parentElement;
    if (!p || p.closest("script,style,noscript,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[aria-hidden=true]")) continue;
    let block = p;
    while (block.parentElement && /^(B|STRONG|I|EM|U|SMALL|SPAN|CODE|MARK|SUB|SUP|ABBR)$/.test(block.tagName)) block = block.parentElement;
    if (blocks.has(block) || !onScreen(block.getBoundingClientRect()) || !shown(block)) continue;
    blocks.add(block);
    const t = block.innerText.replace(/\\s+/g, " ").trim().slice(0, 240);
    if (t.length > 1 && !labels.has(t.toLowerCase())) text.push(t);
  }
  const sc = document.scrollingElement || document.documentElement;
  return { url: location.href, title: document.title, elements: elements.map((o) => o.e), text,
    canScroll: sc.scrollHeight > vh + 4, canGoBack: history.length > 1 };
})()`;

type Target = { type: string; webSocketDebuggerUrl: string };

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
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const perceive = async (): Promise<Page> => {
    for (let i = 0; i < 20 && (await evaluate("document.readyState").catch(() => "loading")) === "loading"; i++) await sleep(250);
    // An app that renders after load shows next to nothing at first.
    let page: Page = await evaluate(PERCEIVE);
    for (let i = 0; i < 10 && page.elements.length + page.text.length < 3; i++) page = (await sleep(500), await evaluate(PERCEIVE));
    return page;
  };
  const at = (i: number) => `document.querySelector('[data-dcu="${i}"]')`;
  const key = async (key: string, code: number) => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
  };

  return {
    perceive,
    async click(i: number) {
      const point = await evaluate(`(() => { const el = ${at(i)}; if (!el) return null; el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width, 1400) / 2, y: r.top + r.height / 2 }; })()`);
      if (!point) return false;
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      return true;
    },
    async type(i: number, text: string) {
      if (!(await evaluate(`(() => { const el = ${at(i)}; el?.focus(); el?.select?.(); return !!el && document.activeElement === el; })()`))) return false;
      await send("Input.insertText", { text });
      return true;
    },
    // A native <select>'s option, by its position, as a person picking it would.
    choose: (i: number, option: number) =>
      evaluate(`(() => { const el = ${at(i)}; if (!el?.options?.[${option}]) return false; el.selectedIndex = ${option};
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`),
    enter: () => key("Enter", 13),
    escape: () => key("Escape", 27),
    scroll: (down: boolean) => evaluate(`scrollBy(0, ${down ? "" : "-"}innerHeight * 0.8)`),
    back: () => evaluate("history.back()"),
    navigate: (url: string) => send("Page.navigate", { url }),
    // The whole page's text, for the report (a field's value isn't part of it).
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
