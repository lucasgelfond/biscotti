import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { declined, escapeHtml, htmlPage, input, localTools, secret, str, text, type Context, type Plugin, type Tool, type Tools } from "@biscotti/core";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { sql } from "drizzle-orm";

// Any remote MCP server's tools, named <server>_<tool>: Notion's (https://mcp.notion.com/mcp), Linear's, Sentry's…
// `mcp_connect` adds one. A server that signs in with OAuth gets a sign-in link, and the grant is kept here; one that
// takes a token reads it from the vault entry "MCP: <server>" (field "token"). Reading and adding run at once;
// anything that could change or delete something asks the owner first.

const PORT = Number(process.env.MCP_OAUTH_PORT ?? 4793);
const NAME = /^[a-z][a-z0-9]{0,19}$/;
// Changes that only add something (a page, a comment, an issue).
const ADDS = /(^|[-_])(create|add|append|insert|comment)/i;

type Row = { name: string; url: string; oauth: string | null };
type Grant = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

export default {
  prompt: `Other services: \`mcp_connect\` adds any service with a remote MCP server (e.g. Notion at
https://mcp.notion.com/mcp), and its tools then appear as <name>_<tool>. Text the user the sign-in link it gives.`,

  async tools(ctx) {
    const { db } = ctx;
    db.run(sql`CREATE TABLE IF NOT EXISTS mcp_servers (name text PRIMARY KEY, url text NOT NULL, oauth text)`);
    const rows = () => db.all<Row>(sql`SELECT name, url, oauth FROM mcp_servers`);
    const redirectUrl = process.env.MCP_REDIRECT_URI ?? `https://${process.env.TAILNET_HOST}:9443/mcp-oauth/callback`;

    // The OAuth state of one server, kept in its row; `onLink` gets the sign-in link when one is needed.
    function provider(name: string, onLink: (url: URL) => void = () => {}): OAuthClientProvider {
      const grant = (): Grant => JSON.parse(db.get<{ oauth: string | null }>(sql`SELECT oauth FROM mcp_servers WHERE name = ${name}`)?.oauth ?? "{}");
      const save = (part: Grant) => void db.run(sql`UPDATE mcp_servers SET oauth = ${JSON.stringify({ ...grant(), ...part })} WHERE name = ${name}`);
      return {
        redirectUrl,
        clientMetadata: { client_name: "biscotti", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
        state: () => `${name}.${randomBytes(16).toString("hex")}`,
        clientInformation: () => grant().client,
        saveClientInformation: (client) => save({ client }),
        tokens: () => grant().tokens,
        saveTokens: (tokens) => save({ tokens }),
        redirectToAuthorization: onLink,
        saveCodeVerifier: (verifier) => save({ verifier }),
        codeVerifier: () => grant().verifier ?? "",
      };
    }

    async function connect(row: Row) {
      const token = secret(db, `MCP: ${row.name}`)?.token;
      const client = new Client({ name: "biscotti", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(row.url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : { authProvider: provider(row.name) }));
      return client;
    }

    // Each server's tools, under its name; a server that's down or signed out lists none.
    const asks = new Map<string, boolean>();
    const servers: Tools = {
      async list() {
        const lists = await Promise.all(
          rows().map(async (row) => {
            const client = await connect(row).catch((err) => (console.error(`mcp ${row.name}: ${err.message}`), undefined));
            if (!client) return [];
            const { tools } = await client.listTools().finally(() => client.close());
            return tools.map((t): Tool => {
              asks.set(`${row.name}_${t.name}`, !t.annotations?.readOnlyHint && !(ADDS.test(t.name) && t.annotations?.destructiveHint !== true));
              return { ...t, name: `${row.name}_${t.name}`, description: `${row.name}: ${t.description ?? ""}` };
            });
          }),
        );
        return lists.flat();
      },
      async call(name, args) {
        const row = rows().find((r) => name.startsWith(`${r.name}_`));
        if (!row) return text(`No server for ${name}.`);
        if (asks.get(name) !== false && !(await ctx.ask(`${row.name}: ${name.slice(row.name.length + 1)} with ${JSON.stringify(args).slice(0, 1500)}?`))) return declined;
        const client = await connect(row);
        try {
          return (await client.callTool({ name: name.slice(row.name.length + 1), arguments: args })) as never;
        } finally {
          await client.close();
        }
      },
    };

    // Sign-in callbacks: the state names the server.
    let server: Server | undefined;
    const serve = () => (server ??= createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const name = url.searchParams.get("state")?.split(".")[0] ?? "";
      const row = rows().find((r) => r.name === name);
      const page = (body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage(name, `<h1>${escapeHtml(name)}</h1>${body}`));
      if (!url.pathname.endsWith("/callback") || !row) return void res.writeHead(404).end();
      try {
        await auth(provider(name), { serverUrl: row.url, authorizationCode: url.searchParams.get("code") ?? "" });
        page("<p>Connected. You can close this.</p>");
        void ctx.deliver(`${name} was connected by the user; biscotti restarts in a moment to load its tools.`).then(() => process.exit(0));
      } catch (err) {
        page(`<p>That didn't work: ${escapeHtml(String(err))}</p><p>Ask biscotti for a new link.</p>`);
      }
    }).listen(PORT, "127.0.0.1"));

    const own = localTools([connectTool(ctx, provider, serve)]);
    return {
      list: async () => [...(await own.list()), ...(await servers.list())],
      call: (name, args, caller) => (name === "mcp_connect" ? own.call(name, args, caller) : servers.call(name, args, caller)),
    };
  },
} satisfies Plugin;

// Restart (the service restarts us, and the agent reloads) so a new server's tools load.
const restart = () => void setTimeout(() => process.exit(0), 1000);

function connectTool(ctx: Context, provider: (name: string, onLink: (url: URL) => void) => OAuthClientProvider, serve: () => void) {
  return {
    name: "mcp_connect",
    description: "Add a service by its remote MCP server's URL. Returns a sign-in link to text the user, or says the service needs a token; once connected, biscotti restarts and the service's tools appear.",
    input: input({ name: str("A short lowercase name, e.g. 'notion'."), url: str("e.g. https://mcp.notion.com/mcp") }),
    async run(args: Record<string, unknown>) {
      const name = String(args.name);
      const url = String(args.url);
      if (!NAME.test(name)) return text("The name should be short, lowercase letters and digits, e.g. 'notion'.");
      if (!/^https:\/\//.test(url)) return text("The URL should start with https://.");
      ctx.db.run(sql`INSERT INTO mcp_servers (name, url) VALUES (${name}, ${url}) ON CONFLICT (name) DO UPDATE SET url = excluded.url, oauth = NULL`);
      if (secret(ctx.db, `MCP: ${name}`)?.token) {
        restart();
        return text(`Added ${name}, with its token from the vault. biscotti restarts to load its tools.`);
      }
      serve();
      let link: URL | undefined;
      try {
        const result = await auth(provider(name, (u) => (link = u)), { serverUrl: url });
        if (result === "AUTHORIZED") {
          restart();
          return text(`Added ${name}. biscotti restarts to load its tools.`);
        }
      } catch (err) {
        return text(`${name} doesn't offer a sign-in biscotti can use (${(err as Error).message}). If it takes a token, vault_request "MCP: ${name}" with the field "token", then call mcp_connect again.`);
      }
      return text(link ? `Text the user this sign-in link for ${name}: ${link}` : `${name} gave no sign-in link.`);
    },
  };
}
