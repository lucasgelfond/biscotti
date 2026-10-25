import { expect, test } from "vitest";
import lessons from "../plugins/lessons/index.ts";
import { testContext } from "./support.ts";

// What one task learns about a site reaches the next task on it, and only that one.

async function tools() {
  const t = await lessons.tools!(testContext());
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await (name === "lessons" || name === "forget_lesson" ? t : t.tasks!).call(name, args, { slot: 1 })).content[0] as { text: string }).text;
  return call;
}

test("a goal gets the lessons for the sites it names, by address or by name", async () => {
  const call = await tools();
  await call("save_lessons", {
    sites: [
      { site: "https://www.angelikafilmcenter.com/villageeast", lessons: ["Showtimes are under the film's page, not the calendar."] },
      { site: "fandango.com", lessons: ["The card fields are in a frame: click into it before filling."] },
      { site: "shop-real-sites.vercel.app", lessons: ["Product titles are headings."] },
    ],
  });

  expect(await call("lessons_for", { goal: "Find tickets for Anora at an Angelika theater" })).toContain("angelikafilmcenter.com: Showtimes are under");
  expect(await call("lessons_for", { goal: "Buy 2 tickets on Fandango" })).toContain("fandango.com: The card fields");
  expect(await call("lessons_for", { goal: "Find a flight to SFO on Google Flights" })).toBe("");
  expect(await call("site_lessons", { site: "www.fandango.com" })).toContain("click into it");
  // A goal with an address gets that site's lessons only, not a neighbour's that shares words with it.
  expect(await call("lessons_for", { goal: "Send an email. The site is open: https://mail-real-sites.vercel.app/" })).toBe("");
  expect(await call("lessons_for", { goal: "Order it. The site is open: https://shop-real-sites.vercel.app/" })).toContain("Product titles are headings.");
});

test("each run's reflection rewrites a site's set: at most a few, no repeats or junk, and the owner can list and forget", async () => {
  const call = await tools();
  await call("save_lessons", { sites: [{ site: "bam.org", lessons: ["old wrong lesson"] }] });
  await call("save_lessons", { sites: [{ site: "bam.org", lessons: ["a", "b", "b", "", "c", "d"] }, { site: "not a site", lessons: ["x"] }] });

  const listed = await call("lessons");
  expect(listed.split("\n").map((l) => l.replace(/^#\d+ /, ""))).toEqual(["bam.org: a", "bam.org: b", "bam.org: c"]);
  const id = /#(\d+) bam.org: c/.exec(listed)![1];
  await call("forget_lesson", { id: Number(id) });
  expect(await call("lessons")).not.toContain("bam.org: c");
});
