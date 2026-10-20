import { declined, input, localTools, mcpTools, secret, text, type Context, type Plugin, type Tool } from "@biscotti/core";
import { codeTask } from "./code.ts";

// GitHub's remote MCP server with the owner's fine-grained token, from .env or the vault ("GitHub", field "token").
// Changes that only add (a comment, a branch, a pull request) go ahead; anything that could overwrite or delete asks
// the owner first. Nothing merges: biscotti opens pull requests for the user to review, so merge tools are left out.

const URL = "https://api.githubcopilot.com/mcp/";
const TOOLSETS = "context,repos,issues,pull_requests,users";
const MERGE = /merge/i;
const ADDS = /^(add_|create_(branch|pull_request|repository)$|fork_repository$)/;

const token = (ctx: Context) =>
  process.env.GITHUB_TOKEN || secret(ctx.db, "GitHub")?.token;

export default {
  prompt: `GitHub: repos, issues and pull requests through the GitHub tools. Edits and deletions ask the user themselves. If
GitHub isn't connected, \`github_connect\` says how.

Code changes: \`code_task\` has a coding agent make the change in a VM and opens a draft pull request. Text the user
the PR link from its report. Never merge pull requests; that's the user's call.`,

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
      if (MERGE.test(name)) return text("biscotti doesn't merge; send the user the pull request link.");
      if (!readOnly.has(name) && !ADDS.test(name) && !(await ctx.ask(`GitHub: ${name} with ${JSON.stringify(args).slice(0, 3000)}${JSON.stringify(args).length > 3000 ? " […longer than shown]" : ""}?`)))
        return declined;
      return client.callTool({ name, arguments: args }) as never;
    });
    const code = localTools([codeTask(ctx, pat)]);
    return {
      async list() {
        const list: Tool[] = (await tools.list()).filter((t) => !MERGE.test(t.name));
        for (const t of list) if (t.annotations?.readOnlyHint) readOnly.add(t.name);
        return [...list, ...(await code.list())];
      },
      call: (name, args, caller) => (name === "code_task" ? code.call(name, args, caller) : tools.call(name, args)),
    };
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
