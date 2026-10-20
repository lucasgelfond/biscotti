import type { Element, Page, Rect } from "./page.ts";
import { openPage } from "./page.ts";

// One action at a time: a decision model picks it from the page's options with a calibrated confidence, and code
// carries it out. A writing model writes free text (what to type, which address) and the report, and steps in when the
// decision model is unsure or stuck: it reads the page and sets a focus, the next move in on-screen terms, and the
// decision model picks the element it means. Passwords and cards come only from the vault, which types them itself.

type Choice = { choice: string; confidence: number };
type Box = { box: { top: number; bottom: number; left: number; right: number }; confidence: number };
export type Decide = (state: object, questions: object, assets?: object) => Promise<Record<string, any>>;
export type Write = (instructions: string, packet: object) => Promise<string>;
export interface Vault {
  list(): Promise<{ name: string; fields: string[] }[]>;
  fill(name: string, fields: string[], why: string): Promise<string>;
}

const MAX_STEPS = 40;
const MAX_HANDOFFS = 5;
const MIN_CONFIDENCE = 0.35;
// "done" stands only when the page itself is judged to show the goal achieved.
const MIN_DONE = 0.8;
// To act on the element the focus names instead of the step's own pick, and to click a box in a picture.
const MIN_FOCUSED = 0.6;
const MIN_BOX = 0.4;
// A click that spends money, books, sends or deletes needs the goal to ask for exactly that.
const CONSEQUENTIAL = /\b(buy|pay|purchase|place (your )?order|order now|book now|complete (purchase|order|booking)|send|delete|remove account|subscribe|donate|transfer)\b/i;
const MIN_AUTHORIZED = 0.9;
const CREDENTIAL = /pass(word|code)?|pin\b|cvc|cvv|card number|one-time|otp|2fa|security code|ssn/i;

// Mutually exclusive, so no two options split the same intent.
const ACTIONS = {
  click: "Click one of the on-screen elements: follow a link, press a button, open a menu or a tab. Name it in the element question.",
  choose_option: "Pick an option in a dropdown (a select box): the dropdown and the option in the option question.",
  type_text: "Type into a text field (a search box, a form input). Name the field in the element question. Never for passwords, codes or card details.",
  fill_saved: "Fill a saved login, card or other vault entry into the form: for usernames with passwords, card details and 2FA codes.",
  click_in_picture: "Click something drawn in a picture the page shows (a seat on a seat map, a spot on a map), where there's no element for it.",
  navigate: "Open the website the goal is about in this tab, by address. Not for an on-screen link: click that.",
  press_enter: "Press Return to submit the field or form that has focus.",
  press_escape: "Press Escape to dismiss a dialog, popup or dropdown.",
  scroll_down: "Scroll down to see more of the page.",
  scroll_up: "Scroll up.",
  back: "Go back to the previous page.",
  done: "The goal is achieved: what it asks for is on this page.",
  none: "Nothing here can make progress toward the goal.",
};

// What a click in a picture can aim for, said plainly: models read pictures worse than text. With the legend's colors,
// "the green seat right of the blue one" is found where "an open seat beside mine" isn't.
const TARGETS = {
  center_seat: "the open seat closest to the center of the seat map",
  next_seat: "the open seat immediately to the right of the selected seat",
  continue: "the button that continues to the next step",
};
const colored = (what: string, { open, selected, taken }: Page["legend"]) =>
  what.replace("open seat", open ? `${open} seat` : "open seat").replace("selected seat", selected ? `${selected} seat` : "selected seat") +
  (taken ? ` (${taken} seats are taken)` : "");

// Only what this page can do: an option that can't be carried out is a guaranteed stall.
function options(page: Page, saved: boolean) {
  const fields = page.elements.some((e) => e.field);
  const can: Record<keyof typeof ACTIONS, boolean> = {
    click: page.elements.length > 0,
    choose_option: page.elements.some((e) => e.options?.length),
    type_text: fields,
    fill_saved: fields && saved,
    click_in_picture: page.pictures.length > 0,
    navigate: true,
    press_enter: fields,
    press_escape: true,
    scroll_down: page.canScroll,
    scroll_up: page.canScroll,
    back: page.canGoBack,
    done: true,
    none: true,
  };
  return Object.fromEntries(Object.entries(ACTIONS).filter(([k]) => can[k as keyof typeof ACTIONS]));
}

// Whether a form field is where a vault field goes, by what both are called.
const KINDS = [/pass/i, /user|e-?mail|login/i, /number|card/i, /exp/i, /cvc|cvv|security/i, /code|otp|totp/i, /zip|postal/i, /name/i];
const matches = (vaultField: string, e: Element) => {
  const kind = KINDS.find((k) => k.test(vaultField));
  return !!kind && (kind === KINDS[0] ? e.secret || kind.test(e.text) : kind.test(e.text));
};

const key = (e: Element) => `${e.tag}|${e.text}`;
const label = (e: Element, seen?: Set<string>) =>
  `<${e.tag}> "${e.text}"${e.near ? ` (near "${e.near}")` : ""}${e.href ? ` ${e.href}` : ""}${e.state ? ` (${e.state})` : ""}` +
  `${e.secret ? " (credential field)" : ""}${e.covered ? " (under an overlay)" : ""}${seen && !seen.has(key(e)) ? " (new)" : ""}`;

export async function browse(goal: string, browser: string, { decide, write, vault, log = () => {} }: { decide: Decide; write: Write; vault?: Vault; log?: (line: string) => void }, start?: string) {
  const tab = await openPage(browser);
  const saved = (await vault?.list()) ?? [];
  const history: string[] = [];
  if (start) await tab.navigate(start);
  let page = start ? await tab.settled("") : await tab.perceive();
  let seen: Set<string> | undefined;
  let focus = "";
  let handoffs = 0;
  let outcome = "ran out of steps";
  const where = () => ({ url: page.url, title: page.title });
  const elements = (seen?: Set<string>) => Object.fromEntries(page.elements.map((e) => [String(e.i), label(e, seen)]));

  // The writing model reads the page and says what to do next: a focus, done, or why it's stuck.
  async function handOff(why: string) {
    if (handoffs++ >= MAX_HANDOFFS) return (outcome = why), false;
    const said = await write(
      "A fast decision model drives a browser toward a goal, one action at a time, and has stopped: it's unsure or stuck. Read the page and reply with one line: FOCUS: the next move, in terms of what's on this screen (e.g. 'open the Showtimes tab', 'pick the 7:30 PM showing'); or DONE if the page shows the goal achieved (a button that turned into 'Remove' or a confirmation counts); or STUCK: why it can't be done here.",
      { goal, why, focus, steps: history.slice(-10), page: { ...where(), elements: page.elements.map((e) => label(e)), text: (await tab.fullText()).slice(0, 6000) } },
    );
    log(`handoff (${why}): ${said}`);
    if (/^DONE/i.test(said)) return (outcome = "done"), false;
    const next = /^FOCUS:\s*(.+)/i.exec(said)?.[1];
    if (!next) return (outcome = `stuck: ${said.replace(/^STUCK:\s*/i, "")}`), false;
    focus = next;
    history.push(`(focus: ${focus})`);
    return true;
  }

  // Part of the page (its largest picture by default) as a screenshot named `screen`, for questions about it.
  const shot = async (area: Rect = page.pictures[0]) => ({ area, assets: { screen: { type: "image", format: "png", data_base64: await tab.screenshot(area) } } });
  const box = async ({ area, assets }: Awaited<ReturnType<typeof shot>>, what: string) => {
    const { pick } = (await decide({ screen: "screen" }, { pick: { type: "box", instructions: `In \`screen\`, ${what}.` } }, assets)) as { pick: Box };
    const { left, right, top, bottom } = pick.box;
    return { confidence: pick.confidence, x: area.x + ((left + right) / 2) * area.w, y: area.y + ((top + bottom) / 2) * area.h, w: (right - left) * area.w, h: (bottom - top) * area.h };
  };

  // Which plain target the click is (or the focus), roughly where it is in the picture, then exactly, in a close-up.
  async function clickInPicture() {
    const picture = await shot();
    const { target } = await decide({ goal, previous_actions: history.slice(-8), screen: "screen" }, { target: { type: "choice", instructions: "In `screen`, what should the next click in the picture be?", criteria: TARGETS } }, picture.assets);
    const what = focus || colored(TARGETS[(target as Choice).choice as keyof typeof TARGETS], page.legend);
    const rough = await box(picture, what);
    if (rough.confidence < MIN_BOX) return `couldn't find ${what} in the picture`;
    const area = picture.area;
    const side = Math.min(Math.max(160, 3 * Math.max(rough.w, rough.h)), area.w, area.h);
    const zoom = { x: Math.min(Math.max(rough.x - side / 2, area.x), area.x + area.w - side), y: Math.min(Math.max(rough.y - side / 2, area.y), area.y + area.h - side), w: side, h: side };
    const fine = await box(await shot(zoom), `(a close-up) ${what}`);
    const point = fine.confidence >= MIN_BOX ? fine : rough;
    const before = await tab.pixels(area);
    await tab.clickPoint(point.x, point.y);
    focus = "";
    await new Promise((r) => setTimeout(r, 300));
    return `clicked ${what} in the picture${(await tab.pixels(area)) !== before ? "; the picture changed" : ""}`;
  }

  // What a seat map on screen shows, for the report: how full, and where the best open seats are.
  async function describePicture() {
    const picture = await shot();
    const a = await decide(
      { goal, screen: "screen" },
      {
        seat_map: { type: "noul", instructions: "Is `screen` showing a seat map?" },
        full: { type: "score", instructions: "How full is the seat map in `screen`?", criteria: ["nearly empty", "about a quarter full", "about half full", "mostly full", "sold out"] },
      },
      picture.assets,
    );
    if (a.seat_map.noul < 0.5) return undefined;
    const best = await box(picture, "the best open seats for the goal");
    const across = ["left", "center", "right"][Math.min(2, Math.floor(((best.x - picture.area.x) / picture.area.w) * 3))];
    const down = ["front", "middle", "back"][Math.min(2, Math.floor(((best.y - picture.area.y) / picture.area.h) * 3))];
    return { seat_map: a.full.legend[String(Math.round(a.full.score))], best_open_seats: `${down} ${across} of the picture` };
  }

  // The vault entry Jev picks, typed starting where its first value belongs (the username box for a login).
  async function fillSaved(named?: Element) {
    const { entry } = (await decide(
      { goal, page: where(), form_fields: page.elements.filter((e) => e.field).map((e) => label(e)) },
      { entry: { type: "choice", instructions: "Which saved entry fills this form?", criteria: { ...Object.fromEntries(saved.map((s, i) => [String(i), `${s.name}: ${s.fields.join(", ")}`])), none: "None fits." } } },
    )) as { entry: Choice };
    const fill = saved[Number(entry.choice)];
    const field = (fill && page.elements.find((e) => e.field && matches(fill.fields[0], e))) ?? (named?.field ? named : page.elements.find((e) => e.field));
    if (!fill || !field) return "fill_saved, but no saved entry fits";
    if (!(await tab.click(field.i))) return `couldn't focus ${label(field)}`;
    return `fill_saved ${fill.name} from ${label(field)}: ${await vault!.fill(fill.name, fill.fields, goal.slice(0, 200))}`;
  }

  async function typeText(named?: Element) {
    const field = named?.field ? named : page.elements.find((e) => e.field && !e.secret);
    if (!field) return "type_text, but no field";
    // A credential field is the vault's to fill, whichever action named it.
    if (field.secret || CREDENTIAL.test(field.text)) return saved.length ? fillSaved(field) : `didn't type into ${label(field)}: passwords and cards come from the vault`;
    const text = await write(
      "You fill in one text field on a web page for someone working toward a goal. Reply with only the exact text to type, or NONE if it shouldn't be filled. Text the goal quotes goes in verbatim. Never make up passwords, codes, card numbers or personal details.",
      { goal, focus, page: where(), field: label(field), previous_actions: history.slice(-8) },
    );
    // What the writer won't make up (an email, a username) a saved entry may have.
    if (!text || text === "NONE" || CREDENTIAL.test(text)) return saved.some((s) => s.fields.some((f) => matches(f, field))) ? fillSaved(field) : `didn't type into ${label(field)}`;
    return (await tab.type(field.i, text)) ? `typed "${text}" into ${label(field)}` : `couldn't focus ${label(field)}`;
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // A dropdown's options, as "<element>.<option>".
      const choices = page.elements.flatMap((e) => (e.options ?? []).map((o, j) => [`${e.i}.${j}`, `${label(e)}: "${o}"`])).slice(0, 200);
      const a = await decide(
        { goal, ...(focus && { focus }), page: where(), previous_actions: history.slice(-8), elements: page.elements.map((e) => label(e, seen)), page_text: page.text },
        {
          kind: {
            type: "choice",
            instructions: `You drive a web browser one action at a time. Which single action makes the most progress toward the goal now? Don't repeat the last action unless the page changed.${focus ? " Work toward the focus, the next step on the way to the goal set by a reviewer; 'done' still means the goal itself." : ""}`,
            criteria: options(page, saved.length > 0),
          },
          ...(page.elements.length && { element: { type: "choice", instructions: "If the next move is to click an element or type into a field, which one? Prefer one that isn't under an overlay.", criteria: elements(seen) } }),
          ...(choices.length && { option: { type: "choice", instructions: "If the next move is to pick a dropdown option, which dropdown and option?", criteria: Object.fromEntries(choices) } }),
          satisfied: { type: "noul", instructions: "Does the page as it stands show the goal achieved?" },
          // The focus names a move in on-screen terms; which element it means is the classifier's call.
          ...(focus && page.elements.length && { focused: { type: "choice", instructions: `Which element does this next move act on: "${focus}"? none if it names nothing on screen.`, criteria: { ...elements(), none: "It names no element on screen." } } }),
        },
      );
      seen = new Set(page.elements.map(key));
      const kind = (a.kind as Choice).choice;
      let target = (kind === "choose_option" ? a.option : a.element) as Choice | undefined;
      if (a.focused && a.focused.choice !== "none" && a.focused.confidence >= MIN_FOCUSED && ["click", "type_text", "fill_saved"].includes(kind)) {
        target = a.focused;
        focus = "";
      }
      const element = page.elements.find((e) => String(e.i) === target?.choice.split(".")[0]);
      const confidence = ["click", "choose_option", "type_text"].includes(kind) ? Math.min(a.kind.confidence, target?.confidence ?? 0) : a.kind.confidence;

      if (kind === "done" && a.satisfied.noul >= MIN_DONE) {
        outcome = "done";
        break;
      }
      if (kind === "done" || kind === "none" || confidence < MIN_CONFIDENCE) {
        const why = kind === "done" ? "it chose done, but the page may not show the goal achieved" : kind === "none" ? "nothing on the page seemed to help" : `unsure (${kind} at ${confidence.toFixed(2)})`;
        if (await handOff(why)) continue;
        break;
      }
      if (kind === "click" && element && CONSEQUENTIAL.test(element.text)) {
        const asked = await decide(
          { goal, page: where(), button: label(element), page_text: page.text.slice(0, 40) },
          {
            commits: { type: "noul", instructions: "Does clicking this button complete a purchase, booking, payment, message or deletion right away, rather than opening a page to choose or review first?" },
            authorized: { type: "noul", instructions: "Does the goal explicitly ask to complete exactly that (buy, book, pay, send, delete…)?" },
          },
        );
        if (asked.commits.noul >= 0.5 && asked.authorized.noul < MIN_AUTHORIZED) {
          outcome = `stopped before ${label(element)}: the goal didn't clearly ask for that`;
          break;
        }
      }

      const before = JSON.stringify(page);
      let did: string = kind;
      if (kind === "click") did = element && (await tab.click(element.i)) ? `click ${label(element)}` : "click (element gone)";
      else if (kind === "choose_option") {
        const option = Number(target?.choice.split(".")[1]);
        did = element && (await tab.choose(element.i, option)) ? `chose "${element.options![option]}" in ${label(element)}` : "choose_option (dropdown gone)";
      } else if (kind === "type_text") did = await typeText(element);
      else if (kind === "fill_saved") did = await fillSaved(element);
      else if (kind === "click_in_picture") did = await clickInPicture();
      else if (kind === "navigate") {
        const url = (await write("Give the single best https URL to open for this goal: the page that already shows what's wanted, such as a search results URL with the query in it (for flights, Google Flights takes https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20SFO%20on%202026-11-10%20one%20way). Reply with only the URL, or NONE.", { goal, focus, previous_actions: history.slice(-8) })).trim();
        if (!/^https:\/\/\S+$/.test(url)) {
          if (await handOff("it didn't know which site to open")) continue;
          break;
        }
        await tab.navigate(url);
        did = `opened ${url}`;
      } else if (kind === "press_enter") await tab.enter();
      else if (kind === "press_escape") await tab.escape();
      else if (kind === "scroll_down" || kind === "scroll_up") await tab.scroll(kind === "scroll_down");
      else if (kind === "back") await tab.back();
      page = await tab.settled(before);
      // Typing shows nowhere (field values aren't read), so typing that happened counts as a change.
      const changed = /^(typed|fill_saved .*: Typed)|the picture changed/.test(did) || JSON.stringify(page) !== before;
      history.push(`${did}${changed ? "" : " (nothing changed)"}`);
      log(`${step + 1} ${kind} ${confidence.toFixed(2)}: ${history.at(-1)}`);
      if (/^fill_saved .*declined/.test(did)) {
        outcome = "the owner declined the fill";
        break;
      }
      // The same move twice on a page it doesn't change is a stall.
      if (!changed && history.at(-2) === history.at(-1) && !(await handOff("the same action twice changed nothing"))) break;
    }
    const picture = page.pictures.length ? await describePicture().catch(() => undefined) : undefined;
    const report = await write(
      "A browser worked toward a goal and stopped. From the page it ended on (its controls show their state, e.g. what a dropdown has chosen) and the steps it took, report to the person who asked: the facts they need (prices, times, names, seats). If the page doesn't show the answer, say what's missing. Two to four sentences, then a last line that is exactly 'Goal done.' or 'Goal not done.'",
      { goal, outcome, steps: history, page: { ...where(), controls: page.elements.map((e) => label(e)), text: await tab.fullText(), ...(picture && { picture }) } },
    );
    return { report, outcome, steps: history, url: page.url };
  } finally {
    tab.close();
  }
}
