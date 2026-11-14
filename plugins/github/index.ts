import { declined, input, localTools, mcpTools, merge, secret, text, type Context, type Plugin } from "@biscotti/core";
import { approvals, MERGES, type Approvals } from "./approvals.ts";
import { codeTask } from "./code.ts";

// GitHub's remote MCP server with the owner's fine-grained token, from .env or the vault ("GitHub", field "token").
// Reads, new branches, commits on a branch other than the default, pull requests, comments and review requests go
// ahead on their own (approvals.ts says which, and logs each); anything that could delete, force-push, write the
// default branch, change the repo's settings, spend or send mail asks the owner first. Nothing merges: biscotti opens
// pull requests for the user to review, so merge tools are left out.

const URL = process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/";
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const TOOLSETS = "context,repos,issues,pull_requests,users";

const token = (ctx: Context) =>
  process.env.GITHUB_TOKEN || secret(ctx.db, "GitHub")?.token;

// A repo's default branch, looked up once and kept: a commit's branch is compared to it, and one that can't be looked
// up asks instead (so a transient failure asks again rather than never).
const defaults = new Map<string, string>();
async function defaultBranch(ctx: Context, repo: string) {
  const known = defaults.get(repo);
  if (known) return known;
  const res = await fetch(`${API}/repos/${repo}`, { headers: { Authorization: `Bearer ${token(ctx)}`, Accept: "application/vnd.github+json" } }).catch(() => undefined);
  const branch = res?.ok ? ((await res.json()) as { default_branch?: string }).default_branch : undefined;
  if (branch) defaults.set(repo, branch);
  return branch;
}

// One session per gate: the repos the owner asked about this conversation, and where auto-approved calls are logged.
const sessions = new WeakMap<Context, Approvals>();
function session(ctx: Context) {
  let found = sessions.get(ctx);
  if (!found) sessions.set(ctx, (found = approvals({ defaultBranch: (repo) => defaultBranch(ctx, repo) })));
  return found;
}

export default {
  prompt: `GitHub: repos, issues and pull requests through the GitHub tools. New branches, commits on a branch other than
the default, pull requests, comments, reactions and review requests go ahead on their own; anything that deletes,
force-pushes, writes the default branch, changes a repo's settings or merges asks the user themselves, inside the tool
call. Merging is always theirs. If GitHub isn't connected, \`github_connect\` says how.

Code changes: \`code_task\` has a coding agent make the change in a VM and opens a draft pull request. Text the user
the PR link from its report. Never merge pull requests; that's the user's call.`,

  // Work the owner asks for in their own words: a repo they name here runs its safe changes without asking again for
  // the rest of the session.
  async observe(ctx) {
    const { note } = session(ctx);
    return {
      turn: (message, from) => {
        if (from?.owner) note(message);
        return () => {};
      },
    };
  },

  async tools(ctx) {
    const pat = token(ctx);
    // Not connected: one tool that says how, as Google's and other services' do.
    if (!pat)
      return localTools([
        {
          name: "github_connect",
          description: "GitHub isn't connected yet. Call this for how to connect it.",
          input: input(),
          run: async () => text(`vault_request a secret named "GitHub" with the field "token", and tell the user to create a fine-grained token at https://github.com/settings/personal-access-tokens/new (the repos they choose; Contents, Issues and Pull requests: read and write) and paste it into the form.`),
        },
      ]);
    const readOnly = new Set<string>();
    const tools = mcpTools(URL, { Authorization: `Bearer ${pat}`, "X-MCP-Toolsets": TOOLSETS }, async (client, name, args) => {
      if (MERGES.test(name)) return text("biscotti doesn't merge; send the user the pull request link.");
      const { risk, why } = await session(ctx).decide({ tool: name, args, readOnly: readOnly.has(name) });
      if (risk === "gated" && !(await ctx.ask(`GitHub: ${name} with ${JSON.stringify(args)}? (${why})`))) return declined;
      return client.callTool({ name, arguments: args }) as never;
    });
    async function list() {
      const listed = (await tools.list()).filter((t) => !MERGES.test(t.name));
      for (const t of listed) if (t.annotations?.readOnlyHint) readOnly.add(t.name);
      return listed;
    }
    return merge({ ...tools, list }, localTools([codeTask(ctx, pat)]));
  },

  // Once a token is saved to the vault, restart (the service restarts us, and the agent reloads) to load GitHub's tools.
  async start(ctx) {
    if (token(ctx)) return;
    const timer = setInterval(() => {
      if (!token(ctx)) return;
      clearInterval(timer);
      void ctx.deliver("GitHub is connected; biscotti restarts in a moment to load its tools.").then(() => process.exit(0));
    }, 10_000);
  },
} satisfies Plugin;
