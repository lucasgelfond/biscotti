import type { Page } from "./page.ts";
import { openPage } from "./page.ts";

// One action at a time: a decision model picks it from the page's options with a calibrated confidence, code carries
// it out, and a writing model only writes free text (what to type, which address) and the final report.

type Choice = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type Answers = Record<string, Choice | { type: "noul"; noul: number }>;
export type Decide = (state: object, questions: object) => Promise<Answers>;
export type Write = (instructions: string, packet: object) => Promise<string>;

const MAX_STEPS = 30;
const MIN_CONFIDENCE = 0.35;
const CREDENTIAL = /pass(word|code)?|pin\b|cvc|cvv|card number|one-time|otp|2fa|security code|ssn/i;

const ACTIONS = {
  click: "Click one of the on-screen elements: follow a link, press a button, open a menu or a tab. Name it in the element question.",
  type_text: "Type into a text field (a search box, a form input). Name the field in the element question. Only when a field needs content.",
  navigate: "Open the website the goal is about in this tab, by address. Not for an on-screen link: click that.",
  press_enter: "Press Return to submit the field or form that has focus.",
  press_escape: "Press Escape to dismiss a dialog, popup or dropdown.",
  scroll_down: "Scroll down to see more of the page.",
  scroll_up: "Scroll up.",
  back: "Go back to the previous page.",
  done: "The goal is achieved: what it asks for is on this page.",
  none: "Nothing here can make progress toward the goal.",
};

function options(page: Page) {
  const fields = page.elements.some((e) => e.field && !e.secret);
  const { click, type_text, press_enter, scroll_down, scroll_up, back, ...rest } = ACTIONS;
  return {
    ...(page.elements.length && { click }),
    ...(fields && { type_text, press_enter }),
    ...(page.canScroll && { scroll_down, scroll_up }),
    ...(page.canGoBack && { back }),
    ...rest,
  };
}

const label = (e: Page["elements"][number]) =>
  `<${e.tag}> "${e.text}"${e.href ? ` ${e.href}` : ""}${e.secret ? " (credential field)" : ""}${e.covered ? " (covered by an overlay)" : ""}`;

export async function browse(goal: string, browser: string, { decide, write }: { decide: Decide; write: Write }, start?: string) {
  const tab = await openPage(browser);
  const history: string[] = [];
  if (start) await tab.navigate(start);
  let page = start ? await tab.settled("") : await tab.perceive();
  let outcome = "ran out of steps";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const answers = await decide(
        {
          goal,
          page: { url: page.url, title: page.title },
          previous_actions: history.slice(-8),
          elements: page.elements.map((e) => ({ i: e.i, element: label(e) })),
          page_text: page.text,
        },
        {
          kind: {
            type: "choice",
            instructions: "You drive a web browser one action at a time. Which single action makes the most progress toward the goal now? Don't repeat the last action unless the page changed.",
            criteria: options(page),
          },
          ...(page.elements.length && {
            element: {
              type: "choice",
              instructions: "If the next move is to click an element or type into a field, which one? Prefer one that isn't covered.",
              criteria: Object.fromEntries(page.elements.map((e) => [String(e.i), label(e)])),
            },
          }),
        },
      );
      const kind = answers.kind as Choice;
      const element = page.elements.find((e) => String(e.i) === (answers.element as Choice | undefined)?.choice);
      const confidence = kind.choice === "click" || kind.choice === "type_text" ? Math.min(kind.confidence, (answers.element as Choice).confidence) : kind.confidence;
      if (kind.choice === "done" || kind.choice === "none") {
        outcome = kind.choice === "done" ? "done" : "stuck";
        break;
      }
      if (confidence < MIN_CONFIDENCE) {
        outcome = `unsure what to do next (${kind.choice}, confidence ${confidence.toFixed(2)})`;
        break;
      }
      const before = JSON.stringify(page);
      let did = kind.choice;
      if (kind.choice === "click") {
        did = element && (await tab.click(element.i)) ? `click ${label(element)}` : "click (element gone)";
      } else if (kind.choice === "type_text") {
        const field = element?.field ? element : page.elements.find((e) => e.field && !e.secret);
        if (!field || field.secret || CREDENTIAL.test(field.text)) {
          outcome = "reached a credential field (logins need the task tool and the vault)";
          break;
        }
        const text = await write(
          "You fill in one text field on a web page for someone working toward a goal. Reply with only the exact text to type, or NONE if it shouldn't be filled. Never make up passwords, codes, card numbers or personal details.",
          { goal, page: { url: page.url, title: page.title }, field: label(field), previous_actions: history.slice(-8) },
        );
        if (!text || text === "NONE" || CREDENTIAL.test(text)) {
          outcome = `didn't know what to type into ${label(field)}`;
          break;
        }
        did = (await tab.type(field.i, text)) ? `typed "${text}" into ${label(field)}` : `couldn't focus ${label(field)}`;
      } else if (kind.choice === "navigate") {
        const url = (await write("Give the single best https URL to open first for this goal: the site's homepage or its most direct public page. Reply with only the URL, or NONE.", { goal, previous_actions: history.slice(-8) })).trim();
        if (!/^https:\/\/[^\s]+$/.test(url)) {
          outcome = "didn't know which site to open";
          break;
        }
        await tab.navigate(url);
        did = `opened ${url}`;
      } else if (kind.choice === "press_enter") await tab.enter();
      else if (kind.choice === "press_escape") await tab.escape();
      else if (kind.choice === "scroll_down" || kind.choice === "scroll_up") await tab.scroll(kind.choice === "scroll_down");
      else if (kind.choice === "back") await tab.back();
      page = await tab.settled(before);
      // Typing shows nowhere (field values aren't read), so it counts as a change.
      const changed = kind.choice === "type_text" || JSON.stringify(page) !== before;
      history.push(`${did}${changed ? "" : " (nothing changed)"}`);
      // The same move twice on a page it doesn't change is a stall.
      if (!changed && history.at(-2) === history.at(-1)) {
        outcome = "stalled";
        break;
      }
    }
    const report = await write(
      "A browser worked toward a goal and stopped. From the page it ended on and the steps it took, report to the person who asked: the facts they need (prices, times, names) and whether the goal was done. If the page doesn't show the answer, say what's missing. Two or three sentences.",
      { goal, outcome, steps: history, page: { url: page.url, title: page.title, text: await tab.fullText() } },
    );
    return { report, outcome, steps: history, url: page.url };
  } finally {
    tab.close();
  }
}
