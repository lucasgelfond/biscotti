// Grades a bench's EverydayBench runs again, with EverydayBench's graders as they are now (after a grader fix):
// EverydayBench keeps each run's world, and the run is named in its saved grade. Rewrites `pass` in the results file
// and says what changed.
//   node tests/bench/regrade.ts /tmp/cu/results.jsonl
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { grade } from "./everydaybench.ts";

const file = process.argv[2]!;
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const out: string[] = [];
for (const line of lines) {
  const r = JSON.parse(line);
  const saved = `${dirname(file)}/${r.model.replace("/", "_")}-${r.guide}${r.label ? `-${r.label}` : ""}/${r.task.replaceAll("/", "__")}${r.run ? `-r${r.run}` : ""}.grade.json`;
  if (existsSync(saved)) {
    const { run } = JSON.parse(readFileSync(saved, "utf8"));
    const graded = await grade(run, r.report).catch(() => undefined);
    if (graded) {
      if (graded.pass !== r.pass) console.log(`${r.label ?? r.model} ${r.task}: ${r.pass ? "passed" : "failed"} -> ${graded.pass ? "passes" : "fails"}`);
      r.pass = graded.pass;
      writeFileSync(saved, JSON.stringify({ run, ...graded }, null, 2));
    }
  }
  out.push(JSON.stringify(r));
}
writeFileSync(file, `${out.join("\n")}\n`);
