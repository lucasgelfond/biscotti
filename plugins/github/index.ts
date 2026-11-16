import { appMethod, declined, input, localTools, mcpTools, merge, text, type Context, type Plugin } from "@biscotti/core";
import { codeTasks } from "./code.ts";
import { githubApi, githubToken as token } from "./git.ts";

// GitHub's remote MCP server with the owner's fine-grained token, from .env or the vault ("GitHub", field "token").
// Biscotti works on GitHub freely (branches, commits, pull requests, comments, edits); it asks the owner first only
// before deleting, removing or closing something. Nothing merges: biscotti opens pull requests for the user to review,
// so merge tools are left out.

const URL = "https://api.githubcopilot.com/mcp/";
const TOOLSETS = "context,repos,issues,pull_requests,users";
const MERGE = /merge/i;
const DESTRUCTIVE = /delete|remove/i;


export default {
  prompt: `GitHub: repos, issues and pull requests through the GitHub tools (load them with \`tool_search\`, e.g. "github pull request"). Go ahead with branches, commits, pull requests, comments and edits without checking with the user; deleting or closing anything asks them itself. If
GitHub isn't connected, \`github_connect\` says how.

Code changes: \`code_task\` has a coding agent make the change in a VM and pushes it to a branch; with preview, the app
stays running from that branch for the owner to use. Use preview whenever the owner will want to see or try what's made
("make me a version of … in French", "change the landing page"): they want the running site, not a diff. Text the owner
the links from its report. A pull request only
once they ask (\`code_pull_request\`); never merge one, that's their call.`,

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
    const tools = mcpTools(URL, { Authorization: `Bearer ${pat}`, "X-MCP-Toolsets": TOOLSETS }, async (client, name, args) => {
      if (MERGE.test(name)) return text("biscotti doesn't merge; send the user the pull request link.");
      const destructive = DESTRUCTIVE.test(name) || args.state === "closed";
      if (destructive && !(await ctx.ask(`GitHub: ${name} with ${JSON.stringify(args)}?`))) return declined;
      return client.callTool({ name, arguments: args }) as never;
    });
    async function list() {
      // Named as GitHub's, so tool_search finds them by it.
      return (await tools.list()).filter((t) => !MERGE.test(t.name)).map((t) => ({ ...t, description: `GitHub: ${t.description ?? ""}` }));
    }
    return merge({ ...tools, list }, localTools(codeTasks(ctx, pat)));
  },

  // Once a token is saved to the vault, restart (the service restarts us, and the agent reloads) to load GitHub's tools.
  // Connected, every hour: a VM still around whose pull request was merged or closed is deleted.
  async start(ctx) {
    if (token(ctx)) {
      setInterval(() => void cleanUp(ctx), Number(process.env.PR_CHECK_MS ?? 3600_000)).unref();
      // The owner's apps read GitHub through biscotti's token (pull requests, checks, diffs), so they need none of
      // their own: the apps' github method {path} -> GitHub's JSON for a GET of one of the repos' read endpoints.
      appMethod("github", async ({ path }) => {
        if (typeof path !== "string" || !/^\/repos\/[\w.-]+\/[\w.-]+\/(pulls|commits|compare|check-runs|actions|branches|contents)(\/|\?|$)/.test(path)) throw new Error("only reads of a repo's pulls, commits, compare, checks, branches or contents");
        return githubApi(token(ctx)!)(path).then(
          (body) => ({ status: 200, body }),
          (err: { status?: number; body?: unknown }) => ({ status: err.status ?? 502, body: err.body ?? null }),
        );
      });
      return;
    }
    const timer = setInterval(() => {
      if (!token(ctx)) return;
      clearInterval(timer);
      void ctx.deliver("GitHub is connected; biscotti restarts in a moment to load its tools.").then(() => process.exit(0));
    }, 10_000);
  },
} satisfies Plugin;

const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
export async function cleanUp(ctx: Context, api = "https://api.github.com") {
  const get = githubApi(token(ctx)!, api);
  for (const v of ctx.vms.alive()) {
    const [, repo, n] = v.pr?.match(PULL) ?? [];
    if (!repo) continue;
    const pull = (await get(`/repos/${repo}/pulls/${n}`).catch(() => undefined)) as { state: string; merged_at: string | null } | undefined;
    if (pull?.state !== "closed") continue;
    console.log(`VM #${v.id}: ${v.pr} was ${pull.merged_at ? "merged" : "closed"}, so it's deleted`);
    await ctx.vms.remove(v.id);
  }
}
