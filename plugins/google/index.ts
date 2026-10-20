import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { declined, input, int, list, localTools, optional, str, text, type Context, type Plugin } from "@biscotti/core";
import { sql } from "drizzle-orm";

// Gmail and Google Calendar over Google's REST APIs, with the owner's own OAuth client. Sending mail and deleting
// events ask the owner first.

const API = process.env.GOOGLE_API_URL ?? "https://www.googleapis.com";
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const PORT = Number(process.env.GOOGLE_PORT ?? 4792);
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events"];

type Args = Record<string, unknown>;

function header(message: { payload?: { headers?: { name: string; value: string }[] } }, name: string) {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// The text/plain parts of a message, decoded.
function body(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts ?? []).map((p) => body(p as typeof part)).join("\n");
}

function rfc822(to: string, subject: string, text: string, inReplyTo?: string) {
  // A line break in a header would add hidden headers (e.g. a Bcc) the owner never approved.
  if (/[\r\n]/.test(to + subject + (inReplyTo ?? ""))) throw new Error("Line breaks aren't allowed in To, Subject or In-Reply-To.");
  const headers = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8"];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${text}`).toString("base64url");
}

function googleApi(ctx: Context) {
  const clientId = ctx.env("GOOGLE_CLIENT_ID");
  const clientSecret = ctx.env("GOOGLE_CLIENT_SECRET");
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? `https://${ctx.env("TAILNET_HOST")}:9443/oauth/callback`;
  ctx.db.run(sql`CREATE TABLE IF NOT EXISTS google_auth (id integer PRIMARY KEY CHECK (id = 1), refresh_token text NOT NULL)`);
  let access: { token: string; expires: number } | undefined;

  async function token(params: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    if (!res.ok) throw new Error(`Google sign-in: ${res.status} ${await res.text()}`);
    const t = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
    return t;
  }

  async function bearer() {
    if (access && access.expires > Date.now()) return access.token;
    const row = ctx.db.get<{ refresh_token: string }>(sql`SELECT refresh_token FROM google_auth`);
    if (!row) throw new Error("Google isn't connected yet: use google_connect and text the user the link.");
    return (await token({ grant_type: "refresh_token", refresh_token: row.refresh_token })).access_token;
  }

  async function call(method: string, path: string, json?: object) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await bearer()}`, ...(json ? { "Content-Type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    if (!res.ok) throw new Error(`Google ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }

  // Sign-in: one pending state at a time; the callback stores the refresh token.
  let state: string | undefined;
  let server: Server | undefined;
  const serve = () => (server ??= createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.endsWith("/callback") || !state || url.searchParams.get("state") !== state) return void res.writeHead(404).end();
    state = undefined;
    try {
      const t = await token({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: redirectUri });
      if (!t.refresh_token) throw new Error("Google sent no refresh token");
      ctx.db.run(sql`INSERT OR REPLACE INTO google_auth VALUES (1, ${t.refresh_token})`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p style='font:17px system-ui'>Google is connected. You can close this.</p>");
      void ctx.deliver("Google was connected by the user.");
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  }).listen(PORT, "127.0.0.1"));

  function signInLink() {
    serve();
    state = randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  return { call, signInLink, redirectUri };
}

export default {
  prompt: `Gmail and Google Calendar: for anything about the user's mail, schedule, appointments, bills or plans, check
their inbox (\`gmail_search\`) and calendar (\`calendar_events\`) first, in parallel. Sending mail and deleting events ask the
user themselves, so just call the tool. If Google isn't connected, \`google_connect\` gives a sign-in link to text them.`,

  async tools(ctx) {
    const { call, signInLink, redirectUri } = googleApi(ctx);
    const confirm = async (question: string) => (await ctx.ask(question)) || undefined;

    return localTools([
      {
        name: "google_connect",
        description: "Get a link for the user to connect their Google account (Gmail and Calendar). Text them the setup note and the link.",
        input: input(),
        run: async () =>
          text(`Text the user both:
1. First time connecting this biscotti: in Google Cloud console → APIs & Services → Credentials → their OAuth client, add ${redirectUri} under "Authorized redirect URIs" and save (otherwise Google says the request is invalid / redirect_uri_mismatch).
2. Then open: ${signInLink()}`),
      },
      {
        name: "gmail_search",
        description: "Search the user's mail with Gmail search syntax (e.g. 'from:amazon newer_than:7d'). Returns id, from, subject, date and snippet.",
        input: input({ query: str(), max: optional(int()) }),
        async run({ query, max }: Args) {
          const q = new URLSearchParams({ q: String(query), maxResults: String(max ?? 10) });
          const { messages = [] } = await call("GET", `/gmail/v1/users/me/messages?${q}`);
          const found = await Promise.all(
            (messages as { id: string }[]).map((m) => call("GET", `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
          );
          if (!found.length) return text("No messages match.");
          return text(found.map((m) => `[${m.id}] ${header(m, "Date")} | ${header(m, "From")} | ${header(m, "Subject")}\n  ${m.snippet}`).join("\n"));
        },
      },
      {
        name: "gmail_read",
        description: "Read one message in full by id (from gmail_search).",
        input: input({ id: str() }),
        async run({ id }: Args) {
          const m = await call("GET", `/gmail/v1/users/me/messages/${encodeURIComponent(String(id))}?format=full`);
          return text(`From: ${header(m, "From")}\nTo: ${header(m, "To")}\nDate: ${header(m, "Date")}\nSubject: ${header(m, "Subject")}\n\n${body(m.payload) || m.snippet}`);
        },
      },
      {
        name: "gmail_draft",
        description: "Save a draft email (nothing is sent).",
        input: input({ to: str(), subject: str(), body: str() }),
        async run({ to, subject, body }: Args) {
          const draft = await call("POST", "/gmail/v1/users/me/drafts", { message: { raw: rfc822(String(to), String(subject), String(body)) } });
          return text(`Saved draft ${draft.id}.`);
        },
      },
      {
        name: "gmail_send",
        description: "Send an email (asks the user first). To reply, pass reply_to with the message id being answered.",
        input: input({ to: str(), subject: str(), body: str(), reply_to: optional(str()) }),
        async run({ to, subject, body, reply_to }: Args) {
          if (!(await confirm(`Send this email to ${to}?\nSubject: ${subject}\n\n${String(body).slice(0, 3000)}${String(body).length > 3000 ? "\n[…longer than shown]" : ""}`))) return declined;
          const original = reply_to ? await call("GET", `/gmail/v1/users/me/messages/${encodeURIComponent(String(reply_to))}?format=metadata&metadataHeaders=Message-ID`) : undefined;
          const raw = rfc822(String(to), String(subject), String(body), original && header(original, "Message-ID"));
          const sent = await call("POST", "/gmail/v1/users/me/messages/send", { raw, ...(original ? { threadId: original.threadId } : {}) });
          return text(`Sent (${sent.id}).`);
        },
      },
      {
        name: "calendar_events",
        description: "List events on the user's primary calendar between two times (ISO 8601 with offset), optionally matching text.",
        input: input({ from: str(), to: str(), query: optional(str()) }),
        async run({ from, to, query }: Args) {
          const q = new URLSearchParams({ timeMin: String(from), timeMax: String(to), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
          if (query) q.set("q", String(query));
          const { items = [] } = await call("GET", `/calendar/v3/calendars/primary/events?${q}`);
          if (!items.length) return text("No events.");
          return text(
            (items as { id: string; summary?: string; location?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }[])
              .map((e) => `[${e.id}] ${e.start.dateTime ?? e.start.date} → ${e.end.dateTime ?? e.end.date} | ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`)
              .join("\n"),
          );
        },
      },
      {
        name: "calendar_create",
        description: "Create an event on the user's primary calendar. Times are ISO 8601 with offset.",
        input: input({ title: str(), start: str(), end: str(), location: optional(str()), attendees: optional(list(str())) }),
        async run({ title, start, end, location, attendees }: Args) {
          const guests = (attendees as string[] | undefined) ?? [];
          const event = await call("POST", `/calendar/v3/calendars/primary/events${guests.length ? "?sendUpdates=all" : ""}`, {
            summary: title,
            location,
            start: { dateTime: start },
            end: { dateTime: end },
            attendees: guests.map((email) => ({ email })),
          });
          return text(`Created event ${event.id}.`);
        },
      },
      {
        name: "calendar_update",
        description: "Change an event's title, times or location by id.",
        input: input({ id: str(), title: optional(str()), start: optional(str()), end: optional(str()), location: optional(str()) }),
        async run({ id, title, start, end, location }: Args) {
          const changes = { ...(title ? { summary: title } : {}), ...(location ? { location } : {}), ...(start ? { start: { dateTime: start } } : {}), ...(end ? { end: { dateTime: end } } : {}) };
          await call("PATCH", `/calendar/v3/calendars/primary/events/${encodeURIComponent(String(id))}`, changes);
          return text("Updated.");
        },
      },
      {
        name: "calendar_delete",
        description: "Delete an event by id (asks the user first).",
        input: input({ id: str() }),
        async run({ id }: Args) {
          const event = await call("GET", `/calendar/v3/calendars/primary/events/${encodeURIComponent(String(id))}`);
          if (!(await confirm(`Delete "${event.summary}" (${event.start?.dateTime ?? event.start?.date}) from your calendar?`))) return declined;
          await call("DELETE", `/calendar/v3/calendars/primary/events/${encodeURIComponent(String(id))}`);
          return text("Deleted.");
        },
      },
    ]);
  },
} satisfies Plugin;
