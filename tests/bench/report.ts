// The computer-use benchmark's results as one Markdown report: each setup's pass rate, time and tokens, which helpers it
// used, a task-by-setup grid, and why each failure failed. cu.ts keeps one up to date as an HTML page in its output folder.
//   node tests/bench/report.ts results.jsonl [more.jsonl…] > report.md
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Result = {
  label?: string;
  model: string;
  guide?: string;
  run?: string;
  task: string;
  pass: boolean;
  seconds: number;
  turns: number;
  llmCalls?: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  tools: Record<string, number>;
  report: string;
};

// Dollars per million tokens (input, cached input, output), from the providers' model lists (October 2026). Jev's
// decisions aren't counted: TypeSafe doesn't publish a per-call price. Runs from before cached tokens were counted
// show no cost.
const PRICES: Record<string, [number, number, number]> = {
  "deepseek/deepseek-v4.1-flash-1017-fast": [0.6, 0.014, 2.4],
  "deepseek/deepseek-v4.1-flash-1017": [0.075, 0.0015, 0.3],
  "alibaba/qwen3.7-flash": [0.03, 0.006, 0.13],
  "alibaba/qwen3.8-27b": [0.5, 0.1, 3],
  "anthropic/claude-haiku-5.5": [0.1, 0.01, 0.5],
  "holo3-1-35b-a3b": [0.25, 0.025, 1.8],
  "holo4-35b-a3b": [0.3, 0.03, 2],
  "holo4-27b": [0.4, 0.04, 3],
};
const cost = (r: Result) => {
  const [input, cached, output] = PRICES[r.model] ?? [0, 0, 0];
  const hits = r.cachedTokens ?? 0;
  return (((r.promptTokens ?? 0) - hits) * input + hits * cached + (r.completionTokens ?? 0) * output) / 1e6;
};

// A run's files, by the names cu.ts writes them under.
const files = (r: Result) => `${r.model.replace("/", "_")}-${r.guide ?? "none"}${r.label ? `-${r.label}` : ""}/${r.task}${r.run ? `-r${r.run}` : ""}`;

export function report(results: Result[], links = false) {
  const setups = [...new Set(results.map((r) => r.label ?? r.model))];
  const tasks = [...new Set(results.map((r) => r.task))];
  const of = (setup: string) => results.filter((r) => (r.label ?? r.model) === setup);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
  // The helpers whose use says whether they earn their place.
  const HELPERS: [string, RegExp][] = [
    ["quick_browse", /quick_browse/],
    ["locate", /__locate$/],
    ["lessons", /lessons/],
    ["zoom", /__zoom$/],
    ["code", /run_code|evaluate/],
  ];

  const out: string[] = ["# Computer-use benchmark", ""];
  out.push("| Setup | Model | Passed | Median time (mean) | Cost per task | Model calls | Prompt tokens (cached) | Output tokens | Helpers used (calls) |", "|---|---|---|---|---|---|---|---|---|");
  for (const setup of setups) {
    const rs = of(setup);
    const used = HELPERS.map(
      ([name, re]) =>
        [
          name,
          rs.reduce(
            (n, r) =>
              n +
              Object.entries(r.tools)
                .filter(([t]) => re.test(t))
                .reduce((m, [, c]) => m + c, 0),
            0,
          ),
        ] as const,
    )
      .filter(([, n]) => n)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
    const prompt = mean(rs.map((r) => r.promptTokens ?? 0));
    const cached = mean(rs.map((r) => r.cachedTokens ?? 0));
    out.push(
      `| ${setup} | ${rs[0].model.replace(/^[a-z]+\//, "")} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${Math.round(median(rs.map((r) => r.seconds)))}s (${Math.round(mean(rs.map((r) => r.seconds)))}s) | ${PRICES[rs[0].model] && rs.every((r) => r.cachedTokens !== undefined) ? `$${mean(rs.map(cost)).toFixed(3)}` : "n/a"} | ${Math.round(mean(rs.map((r) => r.llmCalls ?? 0)))} | ${k(prompt)}${cached ? ` (${Math.round((100 * cached) / prompt)}%)` : ""} | ${k(mean(rs.map((r) => r.completionTokens ?? 0)))} | ${used || "none"} |`,
    );
  }
  // Frontiers: the setups that no other one beats on both pass rate and speed (median time), or on both pass rate and
  // cost (where costs are known). Speed and accuracy matter most; cost next.
  // On the tasks every setup has run, so a setup part-way through (or one that skips the coding task) compares fairly.
  const shared = tasks.filter((t) => setups.every((s) => of(s).some((r) => r.task === t)));
  const points = setups.map((setup) => {
    const rs = of(setup).filter((r) => shared.includes(r.task));
    const known = rs.length > 0 && PRICES[rs[0].model] && rs.every((r) => r.cachedTokens !== undefined);
    return { setup, rate: rs.filter((r) => r.pass).length / rs.length, cost: known ? mean(rs.map(cost)) : undefined, seconds: median(rs.map((r) => r.seconds)) };
  });
  type Point = (typeof points)[number];
  if (!shared.length) return out.join("\n");
  const best = (ps: Point[], by: (p: Point) => number) =>
    ps.filter((p) => !ps.some((q) => q !== p && q.rate >= p.rate && by(q) <= by(p) && (q.rate > p.rate || by(q) < by(p)))).sort((x, y) => by(x) - by(y));
  const show = (p: Point) => `**${p.setup}** ${Math.round(100 * p.rate)}%, ${Math.round(p.seconds)}s${p.cost !== undefined ? `, $${p.cost.toFixed(3)}` : ""}`;
  out.push("", `On the ${shared.length} tasks every setup has run:`, "");
  out.push(`Fastest for the accuracy (no other setup passes more in less time): ${best(points, (p) => p.seconds).map(show).join(" → ")}.`);
  const priced = points.filter((p) => p.cost !== undefined);
  if (priced.length) out.push("", `Cheapest for the accuracy (no other setup passes more for less): ${best(priced, (p) => p.cost!).map(show).join(" → ")}.`);
  out.push("", "Means are per task. ✓ passed, ✗ failed, with seconds; a blank wasn't run.", "");
  out.push(`| Task | ${setups.join(" | ")} |`, `|---|${setups.map(() => "---").join("|")}|`);
  for (const task of tasks)
    out.push(
      `| ${task} | ${setups
        .map((s) =>
          of(s)
            .filter((r) => r.task === task)
            .map((r) => (links ? `[${r.pass ? "✓" : "✗"} ${Math.round(r.seconds)}s](${files(r)}.png)` : `${r.pass ? "✓" : "✗"} ${Math.round(r.seconds)}s`))
            .join(", "),
        )
        .join(" | ")} |`,
    );
  out.push("", "## Failures", "");
  for (const setup of setups)
    for (const r of of(setup).filter((r) => !r.pass))
      out.push(
        `- **${setup} / ${r.task}** (${Math.round(r.seconds)}s, ${r.turns} turns${links ? `, [screen](${files(r)}.png), [trace](${files(r)}.jsonl)` : ""}): ${r.report.replace(/\s+/g, " ").slice(0, 300) || "(no report)"}`,
      );
  return out.join("\n");
}

export const read = (file: string): Result[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Result);

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(report(process.argv.slice(2).flatMap(read)));
