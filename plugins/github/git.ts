import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Context, secret } from "@biscotti/core";

// GitHub with the owner's fine-grained token (from .env, or the vault's "GitHub" entry, field "token"), for this plugin
// and others that check a repo out (ssh-vms).

export const REPO = /^[\w.-]+\/[\w.-]+$/;
export const githubToken = (ctx: Context): string | undefined => process.env.GITHUB_TOKEN || secret(ctx.db, "GitHub")?.token;

// git as the token's owner. The token goes to git as a header in the environment: never in a URL, a remote, its
// arguments (which anyone can read in ps) or a clone's config.
export function gitAs(token: string) {
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}` };
  return async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}

// GitHub's REST API as the token's owner: the answer's JSON, or an error with GitHub's message.
export function githubApi(token: string, base = "https://api.github.com") {
  return async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" } });
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}: ${body?.message ?? JSON.stringify(body)}`), { status: res.status, body });
    return body as never;
  };
}

// A repo (owner/name) at `base` (its default branch otherwise) as a git bundle of its last `depth` commits, with the
// commit it's at and that branch's name. A bare clone: nothing is checked out.
export async function bundleRepo(token: string, repo: string, base?: string, depth = 50) {
  if (!REPO.test(repo)) throw new Error("the repo should be owner/name");
  const git = gitAs(token);
  const dir = mkdtempSync(join(tmpdir(), "github-"));
  try {
    await git(dir, "clone", "-q", "--bare", "--depth", String(depth), ...(base ? ["--branch", base] : []), `https://github.com/${repo}.git`, "repo.git");
    const bare = join(dir, "repo.git");
    await git(bare, "bundle", "create", "-q", join(dir, "in.bundle"), "HEAD");
    return { bundle: readFileSync(join(dir, "in.bundle")), sha: await git(bare, "rev-parse", "HEAD"), branch: base ?? (await git(bare, "rev-parse", "--abbrev-ref", "HEAD")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
