// discriminative-computer-use on real sites, run as a task VM runs it (tests/dcu-harness.ts): outcome and time.
// node tests/bench/dcu.ts [task…]   (TYPESAFE_API_KEY, LLM_BASE_URL, LLM_API_KEY, TASK_MODEL; CHROME for the binary)
import { vault } from "../../core/src/schema.ts";
import { harness } from "../dcu-harness.ts";

const TASKS: Record<string, { goal: string; start?: string; saved?: Record<string, string>; pass: (report: string) => boolean | Promise<boolean> }> = {
  hn: {
    goal: "Report the exact title of the #1 story on Hacker News.",
    start: "https://news.ycombinator.com",
    async pass(report) {
      const [id] = await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json();
      const { title } = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json();
      return report.toLowerCase().includes(title.toLowerCase().slice(0, 25));
    },
  },
  "hn-comments": {
    goal: "Open the comments of the #1 story on Hacker News and report who wrote the first comment.",
    start: "https://news.ycombinator.com",
    pass: () => true,
  },
  wikipedia: {
    goal: "Find the population of Iceland on Wikipedia.",
    start: "https://en.wikipedia.org",
    pass: (r) => /3[0-9]{2}[,.\s]?[0-9]{3}/.test(r),
  },
  "no-start": {
    goal: "Find the release date of Python 3.13 on python.org.",
    pass: (r) => /2024/.test(r),
  },
  github: {
    goal: "On GitHub, find the license of the firecracker-microvm/firecracker repository.",
    start: "https://github.com/firecracker-microvm/firecracker",
    pass: (r) => /apache/i.test(r),
  },
  search: {
    goal: "Search DuckDuckGo for 'firecracker microvm', open the first result, and report its page title.",
    start: "https://duckduckgo.com",
    pass: (r) => /firecracker/i.test(r),
  },
  dropdown: {
    goal: "Choose Option 2 in the dropdown and report what's selected.",
    start: "https://the-internet.herokuapp.com/dropdown",
    pass: (r) => /option 2/i.test(r),
  },
  flights: {
    goal: `Find nonstop flights from JFK to SFO on ${new Date(Date.now() + 21 * 86_400_000).toDateString()} on Google Flights, and report the cheapest few with airline, departure and arrival times, and price.`,
    pass: (r) => /\$\s?\d/.test(r) && /\d{1,2}:\d{2}/.test(r),
  },
  showtimes: {
    goal: "Find today's showtimes at the Angelika Film Center in New York and report three films with their times.",
    start: "https://www.angelikafilmcenter.com/nyc",
    pass: (r) => /\d{1,2}:\d{2}/.test(r),
  },
  seats: {
    goal: "At the Angelika Film Center in New York, open seat selection for the next showing of any film today and describe which seats are open. Don't buy anything.",
    start: "https://www.angelikafilmcenter.com/nyc",
    pass: (r) => /seat/i.test(r),
  },
  sauce: {
    goal: "Log in to saucedemo.com and add the Sauce Labs Backpack to the cart.",
    start: "https://www.saucedemo.com",
    saved: { username: "standard_user", password: "secret_sauce" },
    pass: (r) => /added/i.test(r),
  },
};

async function run(name: string, port: number) {
  const vm = await harness(port);
  const { saved } = TASKS[name];
  if (saved) vm.db.insert(vault).values({ name: `${name} login`, fields: Object.keys(saved), value: saved }).run();
  const started = Date.now();
  try {
    const report = await vm.errand(TASKS[name].goal, TASKS[name].start);
    return { name, pass: /Goal done\.\s*(\(|$)/.test(report.split("\n").at(-1)!) && (await TASKS[name].pass(report)), seconds: (Date.now() - started) / 1000, report };
  } finally {
    vm.close();
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TASKS);
// One at a time: secure-fill finds the browser through a process-wide setting.
const results = [];
for (const [i, name] of names.entries()) results.push(await run(name, 9400 + 2 * i).catch((err: Error) => ({ name, pass: false, error: err.message })));
for (const r of results) {
  if ("error" in r) console.log(`\n== ${r.name}: ERROR ${r.error}`);
  else console.log(`\n== ${r.name}: ${r.pass ? "PASS" : "FAIL"} ${r.seconds.toFixed(1)}s\n   ${r.report.slice(0, 400)}`);
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
