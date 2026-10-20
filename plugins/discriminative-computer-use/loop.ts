import type { Element, Page } from "./page.ts";
import { openPage } from "./page.ts";

// One action at a time: a decision model picks it from the page's options with a calibrated confidence, and code
// carries it out. A writing model writes free text (what to type, which address) and the report, and steps in when the
// decision model is unsure or stuck: it reads the page and sets a focus, the next move in terms of what's on screen,
// which the decision model then works toward. Passwords and cards come only from the vault, which types them itself.

type Choice = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type Noul = { type: "noul"; noul: number };
type Answers = Record<string, Choice | Noul>;
export type Decide = (state: object, questions: object) => Promise<Answers>;
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
// A click that spends money, books, sends or deletes needs the goal to ask for exactly that.
const CONSEQUENTIAL = /\b(buy|pay|purchase|place (your )?order|order now|book now|complete (purchase|order|booking)|send|delete|remove account|subscribe|donate|transfer)\b/i;
const MIN_AUTHORIZED = 0.9;
// How sure the focus's element must be to act on it instead of the step's own pick.
const MIN_FOCUSED = 0.6;
const CREDENTIAL = /pass(word|code)?|pin\b|cvc|cvv|card number|one-time|otp|2fa|security code|ssn/i;

// Mutually exclusive, so no two options split the same intent.
const ACTIONS = {
  click: "Click one of the on-screen elements: follow a link, press a button, open a menu or a tab. Name it in the element question.",
  choose_option: "Pick an option in a dropdown (a select box): the dropdown and the option in the option question.",
  type_text: "Type into a text field (a search box, a form input). Name the field in the element question. Only when a field needs content. Never for passwords, codes or card details.",
  fill_saved: "Fill a saved login, card or other vault entry into the form, starting at the field named in the element question: for usernames with passwords, card details and 2FA codes.",
  navigate: "Open the website the goal is about in this tab, by address. Not for an on-screen link: click that.",
  press_enter: "Press Return to submit the field or form that has focus.",
  press_escape: "Press Escape to dismiss a dialog, popup or dropdown.",
  scroll_down: "Scroll down to see more of the page.",
  scroll_up: "Scroll up.",
  back: "Go back to the previous page.",
  done: "The goal is achieved: what it asks for is on this page.",
  none: "Nothing here can make progress toward the goal.",
};

// Only what this page can do: an option that can't be carried out is a guaranteed stall.
function options(page: Page, saved: boolean) {
  const fields = page.elements.some((e) => e.field);
  const selects = page.elements.some((e) => e.options?.length);
  const { click, choose_option, type_text, fill_saved, press_enter, scroll_down, scroll_up, back, ...rest } = ACTIONS;
  return {
    ...(page.elements.length && { click }),
    ...(selects && { choose_option }),
    ...(fields && { type_text, press_enter }),
    ...(fields && saved && { fill_saved }),
    ...(page.canScroll && { scroll_down, scroll_up }),
    ...(page.canGoBack && { back }),
    ...rest,
  };
}

// Whether a form field is where a vault field goes, by what both are called.
const KINDS = [/pass/i, /user|e-?mail|login/i, /number|card/i, /exp/i, /cvc|cvv|security/i, /code|otp|totp/i, /zip|postal/i, /name/i];
function matches(vaultField: string, e: Element) {
  const kind = KINDS.find((k) => k.test(vaultField));
  if (!kind) return false;
  if (kind === KINDS[0]) return e.secret || kind.test(e.text);
  return !(e.secret && kind !== KINDS[2] && kind !== KINDS[4]) && kind.test(e.text);
}

const key = (e: Element) => `${e.tag}|${e.text}`;
const label = (e: Element, seen?: Set<string>) =>
  `<${e.tag}> "${e.text}"${e.near ? ` (near "${e.near}")` : ""}${e.href ? ` ${e.href}` : ""}${e.state ? ` (${e.state})` : ""}` +
  `${e.secret ? " (credential field)" : ""}${e.covered ? " (under an overlay)" : ""}${seen && !seen.has(key(e)) ? " (new)" : ""}`;

// Three "Add to cart" buttons say nothing about which is which; the nearest label before each that appears once does.
function disambiguate(page: Page) {
  const count = new Map<string, number>();
  for (const e of page.elements) count.set(e.text, (count.get(e.text) ?? 0) + 1);
  let last = "";
  for (const e of page.elements) {
    if (count.get(e.text)! > 1) e.near = last || undefined;
    else last = e.text;
  }
  return page;
}

export async function browse(goal: string, browser: string, { decide, write, vault, log = () => {} }: { decide: Decide; write: Write; vault?: Vault; log?: (line: string) => void }, start?: string) {
  const tab = await openPage(browser);
  const history: string[] = [];
  const saved = (await vault?.list()) ?? [];
  // What fill_saved can fill: each entry whole, in order, or one of its fields.
  const fills = saved.flatMap(({ name, fields }) => [
    { name, fields, label: `${name}: ${fields.join(", ")}, in that order` },
    ...(fields.length > 1 ? fields.map((f) => ({ name, fields: [f], label: `${name}: only ${f}` })) : []),
  ]);
  if (start) await tab.navigate(start);
  let page = disambiguate(start ? await tab.settled("") : await tab.perceive());
  let seen: Set<string> | undefined;
  let focus = "";
  let handoffs = 0;
  let outcome = "ran out of steps";
  const where = () => ({ url: page.url, title: page.title });

  // The writing model reads the page and says what to do next: a focus, done, or why it's stuck.
  async function handOff(why: string) {
    if (handoffs++ >= MAX_HANDOFFS) return (outcome = why), false;
    const said = await write(
      "A fast decision model drives a browser toward a goal, one action at a time, and has stopped: it's unsure or stuck. Read the page and reply with one line: FOCUS: the next move, in terms of what's on this screen (e.g. 'open the Showtimes tab', 'pick the 7:30 PM showing'); or DONE if the page shows the goal achieved (a button that turned into 'Remove' or a confirmation counts); or STUCK: why it can't be done here.",
      { goal, why, focus, steps: history.slice(-10), page: { ...where(), elements: page.elements.map((e) => label(e)), text: (await tab.fullText()).slice(0, 6000) } },
    );
    log(`handoff (${why}): ${said}`);
    if (/^DONE/i.test(said)) return (outcome = "done"), false;
    const set = /^FOCUS:\s*(.+)/i.exec(said)?.[1];
    if (!set) return (outcome = `stuck: ${said.replace(/^STUCK:\s*/i, "")}`), false;
    focus = set;
    history.push(`(focus: ${focus})`);
    return true;
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // A dropdown's options, as "<element>.<option>".
      const choices = page.elements.flatMap((e) => (e.options ?? []).map((o, j) => [`${e.i}.${j}`, `${label(e)}: "${o}"`])).slice(0, 200);
      const answers = await decide(
        { goal, ...(focus && { focus }), page: where(), previous_actions: history.slice(-8), elements: page.elements.map((e) => label(e, seen)), page_text: page.text },
        {
          kind: {
            type: "choice",
            instructions: `You drive a web browser one action at a time. Which single action makes the most progress toward the goal now? Don't repeat the last action unless the page changed.${focus ? " Work toward the focus, the next step on the way to the goal set by a reviewer; 'done' still means the goal itself." : ""}`,
            criteria: options(page, fills.length > 0),
          },
          ...(page.elements.length && {
            element: {
              type: "choice",
              instructions: "If the next move is to click an element or type into a field, which one? Prefer one that isn't under an overlay.",
              criteria: Object.fromEntries(page.elements.map((e) => [String(e.i), label(e, seen)])),
            },
          }),
          ...(choices.length && { option: { type: "choice", instructions: "If the next move is to pick a dropdown option, which dropdown and option?", criteria: Object.fromEntries(choices) } }),
          satisfied: { type: "noul", instructions: "Does the page as it stands show the goal achieved?" },
          // The focus names a move in on-screen terms; which element it means is the classifier's call, not the writer's.
          ...(focus && page.elements.length && {
            focused: {
              type: "choice",
              instructions: `Which element does this next move act on: "${focus}"? none if it names nothing on screen.`,
              criteria: { ...Object.fromEntries(page.elements.map((e) => [String(e.i), label(e)])), none: "It names no element on screen." },
            },
          }),
        },
      );
      seen = new Set(page.elements.map(key));
      const kind = answers.kind as Choice;
      let target = (kind.choice === "choose_option" ? answers.option : answers.element) as Choice | undefined;
      const focused = answers.focused as Choice | undefined;
      if (focused && focused.choice !== "none" && focused.confidence >= MIN_FOCUSED && ["click", "type_text", "fill_saved"].includes(kind.choice)) {
        target = focused;
        focus = "";
      }
      const element = page.elements.find((e) => String(e.i) === target?.choice.split(".")[0]);
      const confidence = ["click", "choose_option", "type_text", "fill_saved"].includes(kind.choice) ? Math.min(kind.confidence, target?.confidence ?? 0) : kind.confidence;

      if (kind.choice === "done") {
        if ((answers.satisfied as Noul).noul >= MIN_DONE) {
          outcome = "done";
          break;
        }
        if (await handOff("it chose done, but the page may not show the goal achieved")) continue;
        break;
      }
      if (kind.choice === "none" || confidence < MIN_CONFIDENCE) {
        if (await handOff(kind.choice === "none" ? "nothing on the page seemed to help" : `unsure (${kind.choice} at ${confidence.toFixed(2)})`)) continue;
        break;
      }
      if (kind.choice === "click" && element && CONSEQUENTIAL.test(element.text)) {
        const asked = await decide(
          { goal, page: where(), button: label(element), page_text: page.text.slice(0, 40) },
          {
            commits: { type: "noul", instructions: "Does clicking this button complete a purchase, booking, payment, message or deletion right away, rather than opening a page to choose or review first?" },
            authorized: { type: "noul", instructions: "Does the goal explicitly ask to complete exactly that (buy, book, pay, send, delete…)?" },
          },
        );
        if ((asked.commits as Noul).noul >= 0.5 && (asked.authorized as Noul).noul < MIN_AUTHORIZED) {
          outcome = `stopped before ${label(element)}: the goal didn't clearly ask for that`;
          break;
        }
      }

      const before = JSON.stringify(page);
      let did: string = kind.choice;
      // A credential field is the vault's to fill, whichever action named it.
      if (kind.choice === "type_text" && element && (element.secret || CREDENTIAL.test(element.text)) && fills.length) kind.choice = "fill_saved";
      if (kind.choice === "click") {
        did = element && (await tab.click(element.i)) ? `click ${label(element)}` : "click (element gone)";
      } else if (kind.choice === "choose_option") {
        const option = Number(target?.choice.split(".")[1]);
        did = element && (await tab.choose(element.i, option)) ? `chose "${element.options![option]}" in ${label(element)}` : "choose_option (dropdown gone)";
      } else if (kind.choice === "type_text") {
        const field = element?.field ? element : page.elements.find((e) => e.field && !e.secret);
        const text =
          field && !field.secret && !CREDENTIAL.test(field.text)
            ? await write(
                "You fill in one text field on a web page for someone working toward a goal. Reply with only the exact text to type, or NONE if it shouldn't be filled. Text the goal quotes goes in verbatim. Never make up passwords, codes, card numbers or personal details.",
                { goal, focus, page: where(), field: label(field), previous_actions: history.slice(-8) },
              )
            : "";
        if (!field) did = "type_text, but no field";
        else if (!text || text === "NONE" || CREDENTIAL.test(text)) did = `didn't type into ${label(field)}: passwords, codes and cards go through fill_saved`;
        else did = (await tab.type(field.i, text)) ? `typed "${text}" into ${label(field)}` : `couldn't focus ${label(field)}`;
      } else if (kind.choice === "fill_saved" && vault) {
        let field = element?.field ? element : page.elements.find((e) => e.field);
        const which = (
          await decide(
            { goal, page: where(), starting_field: field && label(field), form_fields: page.elements.filter((e) => e.field).map((e) => label(e)) },
            { fill: { type: "choice", instructions: "Which saved entry, and which of its fields, fill this form starting at the starting field?", criteria: { ...Object.fromEntries(fills.map((f, i) => [String(i), f.label])), none: "No saved entry fits." } } },
          )
        ).fill as Choice;
        const fill = fills[Number(which.choice)];
        // Typing starts where the entry's first field belongs (the username box for a login), whatever field was named.
        const first = fill && page.elements.find((e) => e.field && matches(fill.fields[0], e));
        if (first) field = first;
        if (!field || !fill) did = "fill_saved, but no saved entry fits";
        else if (!(await tab.click(field.i))) did = `couldn't focus ${label(field)}`;
        else did = `fill_saved ${fill.label} from ${label(field)}: ${await vault.fill(fill.name, fill.fields, goal.slice(0, 200))}`;
      } else if (kind.choice === "navigate") {
        const url = (await write("Give the single best https URL to open for this goal: the page that already shows what's wanted, such as a search results URL with the query in it (for flights, Google Flights takes https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20SFO%20on%202026-11-10%20one%20way). Reply with only the URL, or NONE.", { goal, focus, previous_actions: history.slice(-8) })).trim();
        if (!/^https:\/\/[^\s]+$/.test(url)) {
          if (await handOff("it didn't know which site to open")) continue;
          break;
        }
        await tab.navigate(url);
        did = `opened ${url}`;
      } else if (kind.choice === "press_enter") await tab.enter();
      else if (kind.choice === "press_escape") await tab.escape();
      else if (kind.choice === "scroll_down" || kind.choice === "scroll_up") await tab.scroll(kind.choice === "scroll_down");
      else if (kind.choice === "back") await tab.back();
      page = disambiguate(await tab.settled(before));
      // Typing shows nowhere (field values aren't read), so typing that happened counts as a change.
      const changed = /^(typed|fill_saved .*: Typed)/.test(did) || JSON.stringify(page) !== before;
      history.push(`${did}${changed ? "" : " (nothing changed)"}`);
      log(`${step + 1} ${kind.choice} ${confidence.toFixed(2)}: ${history.at(-1)}`);
      if (/declined/.test(did) && kind.choice === "fill_saved") {
        outcome = "the owner declined the fill";
        break;
      }
      // The same move twice on a page it doesn't change is a stall.
      if (!changed && history.at(-2) === history.at(-1) && !(await handOff("the same action twice changed nothing"))) break;
    }
    const report = await write(
      "A browser worked toward a goal and stopped. From the page it ended on (its controls show their state, e.g. what a dropdown has chosen) and the steps it took, report to the person who asked: the facts they need (prices, times, names, seats). If the page doesn't show the answer, say what's missing. Two to four sentences, then a last line that is exactly 'Goal done.' or 'Goal not done.'",
      { goal, outcome, steps: history, page: { ...where(), controls: page.elements.map((e) => label(e)), text: await tab.fullText() } },
    );
    return { report, outcome, steps: history, url: page.url };
  } finally {
    tab.close();
  }
}
