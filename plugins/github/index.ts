import { declined, localTools, mcpTools, secret, text, type Context, type Plugin, type Tool } from "@biscotti/core";
import { codeTask } from "./code.ts";

// GitHub's remote MCP server with the owner's fine-grained token, from .env or the vault ("GitHub", field "token").
// Anything not marked read-only asks the owner first. Nothing merges: biscotti opens pull requests for the user to
// review, so merge tools are left out.

const URL = "https://api.githubcopilot.com/mcp/";
const TOOLSETS = "context,repos,issues,pull_requests,users";
const MERGE = /merge/i;

const token = (ctx: Context) =>
  process.env.GITHUB_TOKEN || secret(ctx.db, "GitHub")?.token;

export default {
  prompt: `GitHub: repos, issues and pull requests through the GitHub tools. Changes ask the user themselves. If there
are no GitHub tools, GitHub isn't connected: \`vault_request\` a secret named "GitHub" with the field "token", and tell
the user to create a fine-grained token at https://github.com/settings/personal-access-tokens/new (the repos they
choose; Contents, Issues and Pull requests: read and write) and paste it into the form.

Code changes: \`code_task\` has a coding agent make the change in a VM and opens a draft pull request. Text the user
the PR link from its report. Never merge pull requests; that's the user's call.`,

  async tools(ctx) {
    const pat = token(ctx);
    if (!pat) return { list: async () => [], call: async () => ({ content: [{ type: "text", text: "GitHub isn't connected." }] }) };
    const readOnly = new Set<string>();
    const tools = mcpTools(URL, { Authorization: `Bearer ${pat}`, "X-MCP-Toolsets": TOOLSETS }, async (client, name, args) => {
      if (MERGE.test(name)) return text("biscotti doesn't merge; send the user the pull request link.");
      if (!readOnly.has(name) && !(await ctx.ask(`GitHub: ${name} with ${JSON.stringify(args).slice(0, 3000)}${JSON.stringify(args).length > 3000 ? " […longer than shown]" : ""}?`)))
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

  // Once a token is saved to the vault, restart (the service restarts us) so the agent picks up GitHub's tools.
  async start(ctx) {
    if (token(ctx)) return;
    const timer = setInterval(() => {
      if (!token(ctx)) return;
      clearInterval(timer);
      void ctx.deliver("GitHub is connected; biscotti restarts in a moment to load its tools.").then(() => process.exit(0));
    }, 10_000);
  },
} satisfies Plugin;
