// The bench's results as one JSON file, a record per task run with what it took (time, turns, model calls, tokens,
// cost) and how it graded (pass, partial credit, the grade's parts and checks), for slicing later.
//   node tests/bench/export.ts OUT results.jsonl [more.jsonl…] > results.json
// OUT is the folder cu.ts wrote to: the checks of runs from before results carried them come from its grade files.
import { existsSync, readFileSync } from "node:fs";
import { cost, read } from "./report.ts";

const [out, ...inputs] = process.argv.slice(2);
const runs = inputs.flatMap((f) => read(f)).map((r) => {
  // As cu.ts names them: <model>-<guide>[-<label>]/<family>__<name>[-r<run>].grade.json.
  const graded = `${out}/${r.model.replace("/", "_")}-${r.guide ?? "none"}${r.label ? `-${r.label}` : ""}/${r.task.replaceAll("/", "__")}${r.run ? `-r${r.run}` : ""}.grade.json`;
  const grade = existsSync(graded) ? JSON.parse(readFileSync(graded, "utf8")) : undefined;
  const x = r as typeof r & Record<string, unknown>;
  return {
    setup: r.label ?? r.model,
    model: r.model,
    run: r.run,
    task: r.task,
    family: r.task.split("/")[0],
    pass: r.pass,
    progress: x.progress ?? grade?.progress,
    parts: x.parts ?? grade?.parts,
    checks: x.checks ?? grade?.assertions?.map(({ fn, pass }: { fn: string; pass: boolean }) => ({ fn, pass })),
    startedAt: x.startedAt,
    slots: x.slots,
    seconds: r.seconds,
    turns: r.turns,
    llmCalls: r.llmCalls,
    promptTokens: r.promptTokens,
    cachedTokens: r.cachedTokens,
    completionTokens: r.completionTokens,
    cost: cost(r),
    costFrom: r.cost !== undefined ? "billed" : "list prices",
    tools: r.tools,
    report: r.report,
  };
});
console.log(JSON.stringify(runs, null, 2));
