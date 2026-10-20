// discriminative-computer-use on real sites, in a local Chrome: outcome, steps, time, and where the time goes.
// node tests/bench/dcu.ts [task…]   (TYPESAFE_API_KEY, LLM_BASE_URL, LLM_API_KEY, TASK_MODEL; CHROME for the binary)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jev, writer } from "../../plugins/discriminative-computer-use/index.ts";
import { browse } from "../../plugins/discriminative-computer-use/loop.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TASKS: Record<string, { goal: string; start?: string; pass: (report: string) => boolean | Promise<boolean> }> = {
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
    pass: (r) => !/(couldn't|could not|unable|doesn't show)/i.test(r),
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
    pass: (r) => /firecracker/i.test(r) && !/(challenge|verification|captcha|not opened|couldn't|could not)/i.test(r),
  },
  sauce: {
    goal: "On saucedemo.com, add the Sauce Labs Backpack to the cart. The login is standard_user / secret_sauce.",
    start: "https://www.saucedemo.com",
    pass: (r) => /added/i.test(r) && !/(not|never)( been)? added/i.test(r),
  },
};

const env = (name: string) => {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name]!;
};

async function run(name: string, port: number) {
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1280,900", `--user-data-dir=${mkdtempSync(join(tmpdir(), "dcu-"))}`, "about:blank"], { stdio: "ignore" });
  const browser = `http://127.0.0.1:${port}`;
  while (!(await fetch(`${browser}/json/version`).then((r) => r.ok, () => false))) await new Promise((r) => setTimeout(r, 100));
  const decide = jev(env("TYPESAFE_API_KEY"));
  const write = writer({ env });
  const timing = { decide: 0, decisions: 0, write: 0, writes: 0 };
  const started = Date.now();
  try {
    const task = TASKS[name];
    const result = await browse(task.goal, browser, {
      decide: async (state, questions) => {
        const t = Date.now();
        const answers = await decide(state, questions);
        timing.decide += Date.now() - t;
        timing.decisions++;
        return answers;
      },
      write: async (instructions, packet) => {
        const t = Date.now();
        const out = await write(instructions, packet);
        timing.write += Date.now() - t;
        timing.writes++;
        return out;
      },
    }, task.start);
    const pass = await task.pass(result.report);
    return { name, pass, seconds: (Date.now() - started) / 1000, ...timing, ...result };
  } finally {
    proc.kill();
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TASKS);
const results = await Promise.all(names.map((name, i) => run(name, 9400 + i).catch((err: Error) => ({ name, pass: false, error: err.message }))));
for (const r of results) {
  if ("error" in r) {
    console.log(`\n== ${r.name}: ERROR ${r.error}`);
    continue;
  }
  console.log(`\n== ${r.name}: ${r.pass ? "PASS" : "FAIL"} (${r.outcome}) ${r.seconds.toFixed(1)}s, ${r.steps.length} steps; jev ${r.decisions}× avg ${Math.round(r.decide / Math.max(r.decisions, 1))}ms, writer ${r.writes}× ${(r.write / 1000).toFixed(1)}s`);
  for (const s of r.steps) console.log(`   - ${s.slice(0, 160)}`);
  console.log(`   report: ${r.report.replace(/\n/g, " ").slice(0, 400)}`);
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
