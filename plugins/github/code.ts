import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { text, type Context, type LocalTool } from "@biscotti/core";

// Coding tasks without a token in the VM: the gate clones the repo, a task VM works on a copy (a git bundle in, its
// new commits out), and the gate checks them, pushes a biscotti/ branch and opens a draft pull request. Never merged.

const TIMEOUT_MS = 90 * 60_000;
const MAX_BUNDLE = 50 * 1024 * 1024;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function codeTask(ctx: Context, token: string): LocalTool {
  // The token goes to git as a header in the environment: never in a URL, a remote or the clone's config.
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}` };
  const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd, env: gitEnv, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${body.message ?? JSON.stringify(body)}`);
    return body;
  };

  // The VM's commits: on top of the base, inside the size limit, and touching CI only when the goal is about CI.
  async function review(dir: string, bundle: Buffer, goal: string) {
    if (bundle.length > MAX_BUNDLE) throw new Error(`the commits are ${Math.round(bundle.length / 1e6)} MB, over the limit`);
    writeFileSync(join(dir, "out.bundle"), bundle);
    await git(dir, "fetch", "-q", join(dir, "out.bundle"), "HEAD:refs/heads/biscotti-work");
    await git(dir, "merge-base", "--is-ancestor", "HEAD", "biscotti-work").catch(() => {
      throw new Error("the commits don't build on the checked-out branch");
    });
    const files = (await git(dir, "diff", "--name-only", "HEAD", "biscotti-work")).split("\n").filter(Boolean);
    if (files.some((f) => f.startsWith(".github/workflows/")) && !/workflow|\bci\b|github actions/i.test(goal))
      throw new Error(`the commits change CI workflows (${files.filter((f) => f.startsWith(".github/workflows/")).join(", ")}), which the goal didn't ask for`);
    return { files, stat: (await git(dir, "diff", "--shortstat", "HEAD", "biscotti-work")).trim() };
  }

  async function openPullRequest(repo: string, base: string, branch: string, goal: string, report: string) {
    const pull = (draft: boolean) =>
      api(`/repos/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({ title: goal.split("\n")[0].slice(0, 72), head: branch, base, draft, body: `${report}\n\n---\nOpened by biscotti from a coding task. Review it before merging; biscotti never merges.` }),
      });
    // Drafts aren't available on every plan.
    return pull(true).catch((err) => (/draft/i.test(err.message) ? pull(false) : Promise.reject(err)));
  }

  async function run(repo: string, goal: string, base: string | undefined, dir: string) {
    await git(dir, "clone", "-q", "--depth", "50", ...(base ? ["--branch", base] : []), `https://github.com/${repo}.git`, "repo");
    const work = join(dir, "repo");
    const baseBranch = base ?? (await git(work, "rev-parse", "--abbrev-ref", "HEAD"));
    await git(work, "bundle", "create", "-q", join(dir, "in.bundle"), "HEAD");
    const result = await ctx.task!(goal, { repo: readFileSync(join(dir, "in.bundle")), model: "code", timeoutMs: TIMEOUT_MS });
    if (!result.bundle) return `Code task on ${repo} made no commits.\n${result.report}`;
    const { stat } = await review(work, result.bundle, goal);
    const branch = `biscotti/${goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${randomBytes(2).toString("hex")}`;
    await git(work, "push", "-q", "origin", `biscotti-work:refs/heads/${branch}`);
    const pr = await openPullRequest(repo, baseBranch, branch, goal, result.report);
    return `Code task on ${repo}: draft pull request ${pr.html_url} (${stat}). Text the user the link; don't merge it.\n${result.report}`;
  }

  return {
    name: "code_task",
    description:
      "Change code in a GitHub repo: a coding agent works on a copy in a fresh VM, and its commits come back as a draft pull request for the user to review (never merged). Returns at once; a 'Code task report' message with the PR link follows, often many minutes later.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. lucasgelfond/biscotti." },
        goal: { type: "string", description: "The change, complete on its own: the coding agent sees only this and the code." },
        base: { type: "string", description: "Branch to start from; the repo's default branch if omitted." },
      },
      required: ["repo", "goal"],
    },
    async run({ repo, goal, base }) {
      if (!ctx.task) return text("Coding tasks need task VMs, which this machine doesn't have.");
      if (typeof repo !== "string" || !REPO.test(repo)) return text("repo should be owner/name.");
      const dir = mkdtempSync(join(tmpdir(), "code-task-"));
      run(repo, String(goal), base ? String(base) : undefined, dir)
        .catch((err: Error) => `Code task on ${repo} failed: ${err.message}`)
        .then((report) => ctx.deliver(`Code task report: ${report}`))
        .finally(() => rmSync(dir, { recursive: true, force: true }));
      return text("Coding task started; the pull request link comes in a 'Code task report' message.");
    },
  };
}
