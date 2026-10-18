import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { localTools, text, type Plugin } from "./plugin.ts";
import { sql } from "drizzle-orm";

// Logins, cards and licenses in the encrypted database. Entered through one-time forms on the tailnet, never in chat.

const PORT = 4791;
const FORM_TTL_MS = 30 * 60_000;

interface Row {
  name: string;
  fields: string;
  confirm: number;
  value: string;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function form(name: string, fields: string[]) {
  const inputs = fields.map((f) => `<label>${escape(f)}<input name="f:${escape(f)}" autocomplete="off"></label>`).join("");
  return `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title>
<style>body{font:17px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:0 0 1rem}
input:not([type=checkbox]){display:block;width:100%;font:inherit;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.6rem 1.2rem}</style>
<h2>${escape(name)}</h2><form method="post">${inputs}
<label><input type="checkbox" name="confirm" checked> Ask me before each use</label><button>Save</button></form>`;
}

export default {
  prompt: `Secrets: \`vault_list\` shows the saved logins, cards and licenses. Whenever one is needed (logging in, checking
out, or the user asking about it), call \`secret_get\`; it asks the user itself when the secret calls for it. Don't
repeat full passwords or card numbers in texts. To save a new one, \`secret_request\` gives a one-time form link.`,

  async tools(ctx) {
    const { db } = ctx;
    db.run(sql`CREATE TABLE IF NOT EXISTS vault (
      name text PRIMARY KEY NOT NULL, fields text NOT NULL, confirm integer NOT NULL, value text NOT NULL)`);

    const save = (name: string, values: Record<string, string>, confirm: boolean) =>
      db.run(sql`INSERT OR REPLACE INTO vault VALUES (${name}, ${JSON.stringify(Object.keys(values))}, ${confirm ? 1 : 0}, ${JSON.stringify(values)})`);

    // One-time forms, served only once one has been asked for.
    const forms = new Map<string, { name: string; fields: string[] }>();
    let server: Server | undefined;
    const serve = () => (server ??= createServer(async (req, res) => {
      const token = req.url?.slice(1) ?? "";
      const pending = forms.get(token);
      if (!pending) return void res.writeHead(404).end("This link has expired.");
      if (req.method !== "POST") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(form(pending.name, pending.fields));
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      forms.delete(token);
      save(pending.name, Object.fromEntries(pending.fields.map((f) => [f, body.get(`f:${f}`) ?? ""])), body.has("confirm"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p style='font:17px system-ui'>Saved.</p>");
      void ctx.deliver(`Secret "${pending.name}" was saved by the user.`);
    }).listen(Number(process.env.VAULT_PORT ?? PORT), "127.0.0.1"));

    return localTools([
      {
        name: "vault_list",
        description: "List saved secrets (logins, cards, licenses): their names and fields, not their values.",
        input: { type: "object", properties: {} },
        async run() {
          const rows = db.all<Row>(sql`SELECT name, fields, confirm FROM vault ORDER BY name`);
          if (!rows.length) return text("No secrets saved.");
          return text(rows.map((r) => `${r.name}: ${JSON.parse(r.fields).join(", ")}${r.confirm ? " (asks the user first)" : ""}`).join("\n"));
        },
      },
      {
        name: "vault_get",
        description: "Get a saved secret's values by name (from vault_list), to fill a login or checkout. Some ask the user first.",
        input: {
          type: "object",
          properties: { name: { type: "string" }, why: { type: "string", description: "What it's for, shown to the user when they're asked, e.g. 'checkout for 2 train tickets, $34'." } },
          required: ["name", "why"],
        },
        async run({ name, why }) {
          const row = db.get<Row>(sql`SELECT * FROM vault WHERE name = ${name as string}`);
          if (!row) return text(`No secret named "${name}".`);
          if (row.confirm && !(await ctx.ask(`Use "${row.name}" for ${why}? Reply yes or no.`))) return text("The user declined.");
          return text(row.value);
        },
      },
      {
        name: "vault_request",
        description: "Get a one-time link to a form where the user enters a new secret (or replaces one). Text the link; you'll get a message once it's saved.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "e.g. 'Chase Sapphire card' or 'Delta login'." },
            fields: { type: "array", items: { type: "string" }, description: "e.g. ['number', 'expiry', 'cvc', 'name on card'] or ['username', 'password']." },
          },
          required: ["name", "fields"],
        },
        async run({ name, fields }) {
          serve();
          const token = randomBytes(16).toString("hex");
          forms.set(token, { name: name as string, fields: fields as string[] });
          setTimeout(() => forms.delete(token), FORM_TTL_MS);
          return text(`${process.env.VAULT_URL ?? `https://${ctx.env("TAILNET_HOST")}:9443`}/${token}`);
        },
      },
    ]);
  },
} satisfies Plugin;
