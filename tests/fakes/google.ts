import { createServer } from "node:http";

// A stand-in for Google's OAuth token endpoint and the Gmail and Calendar REST APIs, with a seeded inbox and calendar.

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function startFakeGoogle(port: number) {
  const inbox = [
    { id: "m1", threadId: "t1", from: "landlord@example.com", subject: "Rent reminder", date: "Mon, 12 Oct 2026 09:00:00 -0400", body: "Rent of $2,400 is due November 1." },
    { id: "m2", threadId: "t2", from: "dentist@example.com", subject: "Appointment confirmed", date: "Tue, 13 Oct 2026 10:00:00 -0400", body: "See you Tuesday, October 20 at 3:30pm with Dr. Okafor." },
  ];
  const events = [
    { id: "e1", summary: "Dentist (Dr. Okafor)", start: { dateTime: "2026-10-20T15:30:00-04:00" }, end: { dateTime: "2026-10-20T16:30:00-04:00" } },
    { id: "e2", summary: "Dinner with Sam at Lilia", start: { dateTime: "2026-10-21T19:00:00-04:00" }, end: { dateTime: "2026-10-21T21:00:00-04:00" } },
  ];
  const sent: string[] = [];
  const drafts: string[] = [];
  const tokenRequests: URLSearchParams[] = [];

  const message = (m: (typeof inbox)[number]) => ({
    id: m.id,
    threadId: m.threadId,
    snippet: m.body.slice(0, 60),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: m.from },
        { name: "Subject", value: m.subject },
        { name: "Date", value: m.date },
        { name: "Message-ID", value: `<${m.id}@example.com>` },
      ],
      body: { data: b64(m.body) },
    },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const path = url.pathname;

    if (path === "/token") {
      const params = new URLSearchParams(raw);
      tokenRequests.push(params);
      return json(200, { access_token: "fake-access", expires_in: 3600, ...(params.get("grant_type") === "authorization_code" ? { refresh_token: "fake-refresh" } : {}) });
    }
    if (req.headers.authorization !== "Bearer fake-access") return json(401, { error: "unauthorized" });

    if (path === "/gmail/v1/users/me/messages" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const words = q.split(/\s+/).filter((w) => w && !w.includes(":"));
      const found = inbox.filter((m) => words.every((w) => JSON.stringify(m).toLowerCase().includes(w)));
      return json(200, { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    if (path === "/gmail/v1/users/me/messages/send") {
      sent.push(Buffer.from(JSON.parse(raw).raw, "base64url").toString("utf8"));
      return json(200, { id: `sent${sent.length}` });
    }
    const one = path.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
    if (one) {
      const m = inbox.find((x) => x.id === one[1]);
      return m ? json(200, message(m)) : json(404, {});
    }
    if (path === "/gmail/v1/users/me/drafts") {
      drafts.push(Buffer.from(JSON.parse(raw).message.raw, "base64url").toString("utf8"));
      return json(200, { id: `draft${drafts.length}` });
    }

    if (path === "/calendar/v3/calendars/primary/events" && req.method === "GET") return json(200, { items: events });
    if (path === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
      const event = { id: `e${events.length + 1}`, ...JSON.parse(raw) };
      events.push(event);
      return json(200, event);
    }
    const ev = path.match(/^\/calendar\/v3\/calendars\/primary\/events\/(\w+)$/);
    if (ev) {
      const i = events.findIndex((e) => e.id === ev[1]);
      if (i < 0) return json(404, {});
      if (req.method === "DELETE") return void (events.splice(i, 1), res.writeHead(204).end());
      if (req.method === "PATCH") Object.assign(events[i], JSON.parse(raw));
      return json(200, events[i]);
    }
    json(404, { error: `no route ${req.method} ${path}` });
  }).listen(port, "127.0.0.1");

  return { inbox, events, sent, drafts, tokenRequests, close: () => server.close() };
}
