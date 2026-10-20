import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { input, list, localTools, saveSecret, str, text, type LocalTool, type Plugin } from "./plugin.ts";
import type { Db } from "./memory.ts";
import { vault } from "./schema.ts";

// Logins, cards and licenses. No model ever sees a secret, and none is texted: the secure-fill plugin types them into
// task VMs' pages.

const PORT = 4791;
const FORM_TTL_MS = 30 * 60_000;
// Fields that identify rather than unlock (shown to the agent, never scrubbed), unless the name says otherwise, as
// "login password" or "account number" do.
const IDENTIFYING = /user|e-?mail|login|name|exp|zip|postal|address|phone/i;
const SECRET = /pass|pin\b|cvc|cvv|code|secret|token|key|totp|number|ssn|account|security|answer/i;
const isPublic = (field: string) => IDENTIFYING.test(field) && !SECRET.test(field);
// Shorter values (a ZIP, a month) would scrub ordinary text.
const MIN_SCRUBBED = 6;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function form(name: string, fields: string[]) {
  const inputs = fields.map((f) => `<label>${escape(f)}<input name="f:${escape(f)}" autocomplete="off"></label>`).join("");
  return `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title>
<style>body{font:17px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:0 0 1rem}
input:not([type=checkbox]){display:block;width:100%;font:inherit;padding:.5rem;box-sizing:border-box}button{font:inherit;padding:.6rem 1.2rem}</style>
<h2>${escape(name)}</h2><form method="post">${inputs}
<button>Save</button></form>`;
}

// Every saved secret value, for the gate to keep out of model calls.
export function secrets(db: Db) {
  return db
    .select()
    .from(vault)
    .all()
    .flatMap((row) => Object.entries(row.value).filter(([field, value]) => !isPublic(field) && value.length >= MIN_SCRUBBED).map(([field, value]) => ({ label: `${row.name}.${field}`, value })));
}

export default {
  prompt: `Vault: \`vault_list\` shows the saved logins, cards and licenses: their fields, and non-secret values like
usernames. You never see secret values. To save a new one, \`vault_request\` gives a one-time form link; if the user
pastes a secret in chat anyway, \`vault_save\` it. Never text a password; if the user wants to see one, they can look
it up on their own devices.`,

  async tools(ctx) {
    const { db } = ctx;
    const save = (name: string, value: Record<string, string>) => saveSecret(db, name, value);

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
      save(pending.name, Object.fromEntries(pending.fields.map((f) => [f, body.get(`f:${f}`) ?? ""])));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p style='font:17px system-ui'>Saved.</p>");
      void ctx.deliver(`"${pending.name}" was saved to the vault by the user.`);
    }).listen(Number(process.env.VAULT_PORT ?? PORT), "127.0.0.1"));

    const listTool: LocalTool = {
      name: "vault_list",
      description: "List saved secrets (logins, cards, licenses): their names, fields, and non-secret values like usernames.",
      input: input(),
      async run() {
        const rows = db.select().from(vault).orderBy(vault.name).all();
        if (!rows.length) return text("No secrets saved.");
        const field = (f: string, value = "") => (isPublic(f) && value ? `${f} (${value})` : f);
        return text(rows.map((r) => `${r.name}: ${r.fields.map((f) => field(f, r.value[f])).join(", ")}`).join("\n"));
      },
    };
    const saveTool: LocalTool = {
      name: "vault_save",
      description: "Save a secret the user typed in chat (so it needn't be typed again), or replace one's values. For new ones, prefer vault_request.",
      input: input({
        name: str("e.g. 'Delta login'."),
        values: { type: "object", additionalProperties: str(), description: "e.g. { username, password }." },
      }),
      async run({ name, values }) {
        save(name as string, values as Record<string, string>);
        return text(`Saved "${name}".`);
      },
    };
    const request: LocalTool = {
      name: "vault_request",
      description: "Get a one-time link to a form where the user enters a new secret (or replaces one). Text the link; you'll get a message once it's saved.",
      input: input({
        name: str("e.g. 'Chase Sapphire card' or 'Delta login'."),
        fields: list(str(), "e.g. ['number', 'expiry', 'cvc', 'name on card'], ['username', 'password'], or 'totp' for a 2FA setup key."),
      }),
      async run({ name, fields }) {
        serve();
        const token = randomBytes(16).toString("hex");
        forms.set(token, { name: name as string, fields: fields as string[] });
        setTimeout(() => forms.delete(token), FORM_TTL_MS);
        return text(`${process.env.VAULT_URL ?? `https://${ctx.env("TAILNET_HOST")}:9443`}/${token}`);
      },
    };
    return { ...localTools([listTool, saveTool, request]), tasks: localTools([listTool]) };
  },
} satisfies Plugin;
