import { mcpTools, type Plugin, type Tool } from "@biscotti/core";

// GitHub's remote MCP server with the owner's fine-grained token. Anything not marked read-only asks the owner first.

const URL = "https://api.githubcopilot.com/mcp/";
const TOOLSETS = "context,repos,issues,pull_requests,users";

export default {
  prompt: "GitHub: repos, issues and pull requests through the GitHub tools. Changes ask the user themselves.",

  async tools(ctx) {
    const readOnly = new Set<string>();
    const tools = mcpTools(URL, { Authorization: `Bearer ${ctx.env("GITHUB_TOKEN")}`, "X-MCP-Toolsets": TOOLSETS }, async (client, name, args) => {
      if (!readOnly.has(name) && !(await ctx.ask(`GitHub: ${name} with ${JSON.stringify(args).slice(0, 800)}?\n\nReply yes or no.`)))
        return { content: [{ type: "text", text: "The user declined." }] };
      return client.callTool({ name, arguments: args }) as never;
    });
    return {
      ...tools,
      async list() {
        const list: Tool[] = await tools.list();
        for (const t of list) if (t.annotations?.readOnlyHint) readOnly.add(t.name);
        return list;
      },
    };
  },
} satisfies Plugin;
