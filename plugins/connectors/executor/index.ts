import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mcpTools, type CallToolResult, type Context, type Plugin } from "@biscotti/core";

// Executor's apps over MCP. Paused calls are resumed with the owner's answer; `resume` itself is never offered.

const BASE = process.env.EXECUTOR_URL ?? "http://127.0.0.1:4788";
const APPS = ["google", "github"];

// Executor reports a paused call as JSON text: {"status":"approval-required","requestId":…,"elicitation":{…}}.
function paused(result: CallToolResult) {
  const text = result.content?.find((c) => c.type === "text")?.text;
  try {
    const body = JSON.parse(text ?? "");
    if (body.status === "approval-required") return { requestId: body.requestId as string, message: (body.elicitation?.message ?? "") as string };
  } catch {}
  return undefined;
}

async function json(res: Promise<Response>) {
  const r = await res;
  if (!r.ok) throw new Error(`executor ${new URL(r.url).pathname}: ${r.status} ${await r.text()}`);
  return r.json();
}

// First run: the owner's admin account, the agent's token and the catalog apps. Auth requests need Executor's origin.
async function token(ctx: Context): Promise<string> {
  const file = `${ctx.dir}/executor-token`;
  if (process.env.EXECUTOR_API_KEY) return process.env.EXECUTOR_API_KEY;
  if (existsSync(file)) return readFileSync(file, "utf8");
  const { setup } = await json(fetch(`${BASE}/api/auth/self-host/config`));
  if (!setup) throw new Error("Executor is already set up: create an API key in its UI and set EXECUTOR_API_KEY");

  const headers = { "Content-Type": "application/json", Origin: process.env.EXECUTOR_ORIGIN ?? `https://${ctx.env("TAILNET_HOST")}:8443` };
  const signup = await fetch(`${BASE}/api/auth/self-host/setup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "biscotti owner", email: ctx.env("OWNER_EMAIL"), password: ctx.env("EXECUTOR_ADMIN_PASSWORD"), organizationName: "biscotti" }),
  });
  if (!signup.ok) throw new Error(`executor setup: ${signup.status} ${await signup.text()}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const [{ id: organization }] = await json(fetch(`${BASE}/api/auth/organization/list`, { headers: { cookie } }));
  const { key } = await json(
    fetch(`${BASE}/api/auth/api-key/create`, {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ name: "biscotti agent", metadata: { organization } }),
    }),
  );
  for (const entry of APPS)
    await json(
      fetch(`${BASE}/api/organizations/${organization}/apps/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ entry, name: entry }),
      }),
    );
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export default {
  prompt: `Connected apps (Gmail, Calendar, Drive, GitHub) come through Executor's tools (\`search\`, \`describe\`, \`call\`, \`execute\`):
- Find a tool with \`search\`, then \`call\` it. Use \`execute\` only when one result feeds the next.
- Prefer an app's high-level tools (e.g. \`tools.google.gmail.send\`) over its raw \`tools.<app>.api.*\` ones, which
  mirror the service's HTTP API and are easy to get wrong.
- To connect an account, send the user the connection link.`,
  async tools(ctx) {
    const tools = mcpTools(`${BASE}/mcp`, { Authorization: `Bearer ${await token(ctx)}` }, async (client, name, args) => {
      let result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      for (let p = paused(result); p; p = paused(result)) {
        const yes = await ctx.ask(`Okay to do this?\n${p.message.slice(0, 1200)}\n\nReply yes or no.`);
        const response = yes ? { action: "accept", content: {} } : { action: "decline" };
        result = (await client.callTool({ name: "resume", arguments: { requestId: p.requestId, response } })) as CallToolResult;
      }
      return result;
    });
    return { ...tools, list: async () => (await tools.list()).filter((t) => t.name !== "resume") };
  },
} satisfies Plugin;
