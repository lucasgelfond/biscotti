import { mcpTools, type Plugin } from "@biscotti/core";

// Web search and page fetching through Exa's hosted MCP server.
export default {
  prompt: `For lookups (showtimes, prices, hours, news), search and fetch the web yourself with \`web_search_exa\` and
\`web_fetch_exa\`, one search per thing in parallel (e.g. one per theater).`,
  tools: async (ctx) => mcpTools("https://mcp.exa.ai/mcp", { "x-api-key": ctx.env("EXA_API_KEY") }),
} satisfies Plugin;
