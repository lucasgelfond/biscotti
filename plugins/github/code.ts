import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bool, input, int, optional, str, text, type Context, type LocalTool } from "@biscotti/core";
import { emit, type TaskResult, vms } from "@biscotti/tasks";
import { sql } from "drizzle-orm";
import { bundleRepo, githubApi, gitAs, REPO } from "./git.ts";

// Coding tasks with no token in the VM: a git bundle in, its commits out (made with jj in the VM); the gate checks them
// and pushes them to a new biscotti/ branch, after the first run and after each follow-up (tell_task). A pull request
// (a draft, never merged) only once the owner asks: code_pull_request. With `preview`, the app is left running in the
// VM from that branch, served on the tailnet, and the VM stays open; otherwise it's deleted once done. A VM still
// around is deleted once its pull request is merged or closed (index.ts).

const TIMEOUT_MS = 90 * 60_000;
// The coding agent's instructions, besides a task's.
const CODING = readFileSync(new URL("./CODING.md", import.meta.url), "utf8");
// The task's commits since `base` (its checkout, in ~/repo, by the VM's setup), with anything left uncommitted
// committed first (in jj, the working copy's change, described if it isn't yet, and a new empty one on top, so git's
// HEAD has it), as a bundle at /tmp/out.bundle; prints "none" when there are none.
export const COMMITS = (base: string) => `set -e
cd ~/repo
if [ -d .jj ] && [ "$(jj log --no-graph -r @ -T empty)" = false ]; then
  [ -n "$(jj log --no-graph -r @ -T description)" ] || jj describe -m "Changes at the end of the task"
  jj new
fi
git add -A
[ -z "$(git status --porcelain)" ] || git commit -q -m "Uncommitted changes at the end of the task"
if [ "$(git rev-parse HEAD)" = "${base}" ]; then echo none; else git bundle create -q /tmp/out.bundle ${base}..HEAD; echo bundled; fi`;
const MAX_BUNDLE = 50 * 1024 * 1024;
const PREVIEW = `

Preview: the owner wants to use what you made, so once it works, leave it running for them: serve the app on 0.0.0.0:8000, detached so it outlives you (setsid nohup … > /tmp/preview.log 2>&1 &), and check it answers with curl. Don't use the app in the VM's browser beyond a quick look (a screenshot that it renders): the VM has 2 CPUs and no GPU, so heavy work in a page (training, rendering, long computations) starves everything, the preview server and you included. Close the browser when you're done looking (pkill -f chromium). A production build served statically, or the project's preview or dev server, whichever is closest to how it ships. It's reached through a proxy under another host name, so let the server answer any Host header (e.g. Vite's server.allowedHosts: true, or --host 0.0.0.0). Say in your report how it's served.`;

// What each coding task works on, by task number (kept in the database across restarts).
interface Work {
  repo: string;
  base: string;
  sha: string;
  branch: string;
  goal: string;
  preview?: boolean;
  pr?: string;
  report?: string;
}

export function codeTasks(ctx: Context, token: string): LocalTool[] {
  const git = gitAs(token);
  const api = githubApi(token) as (path: string, init?: RequestInit) => Promise<any>;

  ctx.db.run(sql`CREATE TABLE IF NOT EXISTS code_tasks (id integer PRIMARY KEY, work text NOT NULL)`);
  const works = new Map(ctx.db.all<{ id: number; work: string }>(sql`SELECT * FROM code_tasks`).map((r) => [r.id, JSON.parse(r.work) as Work]));
  const save = (id: number) => ctx.db.run(sql`INSERT OR REPLACE INTO code_tasks (id, work) VALUES (${id}, ${JSON.stringify(works.get(id))})`);

  // The VM's commits: on top of the base, inside the size limit, and nothing under .github/ (a pushed branch runs the
  // repo's workflows, with its secrets; a changed one would run the VM's code there).
  async function review(dir: string, sha: string, bundle: Buffer) {
    if (bundle.length > MAX_BUNDLE) throw new Error(`the commits are ${Math.round(bundle.length / 1e6)} MB, over the limit`);
    writeFileSync(join(dir, "out.bundle"), bundle);
    await git(dir, "fetch", "-q", join(dir, "out.bundle"), "HEAD:refs/heads/biscotti-work");
    await git(dir, "merge-base", "--is-ancestor", sha, "biscotti-work").catch(() => {
      throw new Error("the commits don't build on the commit the task started from");
    });
    // NUL-separated, so a name with unusual characters isn't quoted past the check.
    const files = (await git(dir, "diff", "--name-only", "-z", "--no-renames", sha, "biscotti-work")).split("\0").filter(Boolean);
    const github = files.filter((f) => f.toLowerCase().startsWith(".github/"));
    if (github.length) throw new Error(`the commits change ${github.join(", ")}; biscotti doesn't push changes under .github/, so make those yourself`);
    return { stat: (await git(dir, "diff", "--shortstat", sha, "biscotti-work")).trim() };
  }

  // A run's commits (the first's, or a follow-up's on top) pushed to the task's branch, and what to tell the owner.
  async function push(id: number, result: TaskResult): Promise<TaskResult> {
    const w = works.get(id)!;
    w.report = result.report;
    save(id);
    const site = w.preview ? await vms(ctx).site(id) : undefined;
    if (site) emit({ id, type: "started", site, text: `Preview: ${site}` });
    const served = site ? ` Its preview, running from that branch in its VM: ${site}` : "";
    if (!result.collected) return { ...result, report: `Code task #${id} on ${w.repo} made no new commits.${served}\n${result.report}` };
    const dir = mkdtempSync(join(tmpdir(), "code-task-"));
    try {
      // A bare repo with just the task's base commit, to check the commits against and push from.
      const work = join(dir, "repo.git");
      await git(dir, "init", "-q", "--bare", work);
      await git(work, "fetch", "-q", "--depth", "1", `https://github.com/${w.repo}.git`, w.sha);
      const { stat } = await review(work, w.sha, result.collected);
      // Forced: a follow-up's commits replace the branch (jj may have rewritten the earlier ones).
      await git(work, "push", "-q", "-f", `https://github.com/${w.repo}.git`, `biscotti-work:refs/heads/${w.branch}`);
      const compare = `https://github.com/${w.repo}/compare/${w.base}...${w.branch}`;
      return {
        ...result,
        report: `Code task #${id} on ${w.repo}: pushed to branch ${w.branch} (${stat}), diff ${compare}${w.pr ? `, pull request ${w.pr}` : ""}.${served} Text the owner the ${site ? "preview and the " : ""}diff link. Open a pull request only once they ask (code_pull_request).\n${result.report}`,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function start(repo: string, goal: string, base: string | undefined, preview: boolean, keep: boolean, parent?: string) {
    const checkout = await bundleRepo(token, repo, base);
    const id = vms(ctx).reserve();
    const branch = `biscotti/${goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${randomBytes(2).toString("hex")}`;
    works.set(id, { repo, base: checkout.branch, sha: checkout.sha, branch, goal, preview });
    save(id);
    const result = await vms(ctx).run(preview ? goal + PREVIEW : goal, {
      id,
      repo: checkout.bundle,
      model: "code",
      instructions: CODING,
      check: false,
      collect: { command: COMMITS(checkout.sha), file: "/tmp/out.bundle" },
      timeoutMs: TIMEOUT_MS,
      parent,
      keep: keep || preview,
      after: (r) => push(id, r),
    });
    return result.report;
  }

  return [
    {
      name: "code_task",
      description:
        "Change code in a GitHub repo: a coding agent works on a copy in a fresh VM (with jj), and its commits are pushed to a new branch; no pull request unless the owner asks for one later (code_pull_request). With preview, the app is left running from that branch in the VM, for the owner to use. Returns at once; a 'Code task report' message with the diff (and preview) link follows, often many minutes later. Follow-ups (tell_task) carry on in the same VM and push to the same branch.",
      input: input({
        repo: str("owner/name, e.g. lucasgelfond/biscotti."),
        goal: str("The change, complete on its own: the coding agent sees only this and the code."),
        base: optional(str("Branch to start from; the repo's default branch if omitted.")),
        preview: optional(bool("Leave the app running for the owner to use (a web app's site), when they want to see or try the result. Keeps the VM open.")),
        keep: optional(bool("Keep its VM open once it's done, when the owner asks to. Otherwise it's deleted once done (unless preview).")),
      }),
      async run({ repo, goal, base, preview, keep }, caller) {
        if (typeof repo !== "string" || !REPO.test(repo)) return text("repo should be owner/name.");
        start(repo, String(goal), base ? String(base) : undefined, preview === true, keep === true, caller.session)
          .catch((err: Error) => `Code task on ${repo} failed: ${err.message}`)
          .then((report) => ctx.deliver(`Code task report: ${report}`, undefined, caller.session));
        return text(`Coding task started; the diff${preview === true ? " and preview" : ""} link comes in a 'Code task report' message.`);
      },
    },
    {
      name: "code_pull_request",
      description: "Open a draft pull request for a coding task's branch (its number), only once the owner asks for one. Never merged.",
      input: input({ id: int(), title: optional(str("The pull request's title; the task's goal's first line if omitted.")) }),
      async run({ id, title }) {
        const w = works.get(Number(id));
        if (!w) return text(`No coding task #${id}.`);
        if (w.pr) return text(`#${id} already has a pull request: ${w.pr}`);
        const pull = (draft: boolean) =>
          api(`/repos/${w.repo}/pulls`, {
            method: "POST",
            body: JSON.stringify({ title: (title ? String(title) : w.goal.split("\n")[0]).slice(0, 72), head: w.branch, base: w.base, draft, body: `${w.report ?? ""}\n\n---\nOpened by biscotti from a coding task. Review it before merging; biscotti never merges.` }),
          });
        // Drafts aren't available on every plan.
        const pr = await pull(true).catch((err: Error) => (/draft/i.test(err.message) ? pull(false) : Promise.reject(err)));
        w.pr = pr.html_url;
        save(Number(id));
        vms(ctx).note(Number(id), { pr: w.pr });
        return text(`Opened a draft pull request for #${id}: ${w.pr}. Text the owner the link; don't merge it.`);
      },
    },
  ];
}
