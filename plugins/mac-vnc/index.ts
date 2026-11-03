import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { escapeHtml, input, localTools, optional, str, text, type Plugin } from "@biscotti/core";

// The owner's home Mac in the browser: noVNC and websockify run on the Mac (mac/install.sh), and this proxies to them
// over the tailnet under an expiring, unguessable path. Tailnet-only (tailscale serve on :9443/mac, never Funnel).

const PORT = Number(process.env.MAC_VNC_PORT ?? 4794);
const TTL_MS = 2 * 60 * 60_000;
// Tailscale serve strips its /mac mount; either way, the session id comes first.
const ROUTE = /^(?:\/mac)?\/([0-9a-f]{24})(\/.*)?$/;

const sessions = new Map<string, { id: string; createdAt: number; note?: string }>();
function session(id: string) {
  for (const [key, s] of sessions) if (Date.now() - s.createdAt > TTL_MS) sessions.delete(key);
  return sessions.get(id);
}

const page = (id: string, expires: string, note?: string) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>biscotti · mac</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #fff; color: #000; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
  header { display: flex; align-items: center; gap: 16px; padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left)); border-bottom: 1px solid #000; }
  .name { font-weight: 600; }
  .note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note::before { content: "● "; color: #2400ff; }
  .expires { color: #555; }
  button { font: inherit; padding: 3px 10px; border: 1px solid #000; background: #fff; color: #000; cursor: pointer; transition: transform 120ms ease-out; }
  button:active { transform: scale(0.97); }
  @media (hover: hover) and (pointer: fine) { button:hover { background: #000; color: #fff; } }
  iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: #f4f4f4; }
</style>
<header>
  <span class="name">biscotti</span>
  <span class="note">${escapeHtml(note ?? "your mac")}</span>
  <span class="expires">until ${expires}</span>
  <button onclick="document.querySelector('iframe').requestFullscreen()">[ full screen ]</button>
</header>
<iframe src="/mac/${id}/vnc/vnc.html?autoconnect=1&amp;resize=remote&amp;path=mac/${id}/ws" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`;

export default {
  prompt: `Mac: the owner's home Mac can be opened as a live desktop in the browser (VNC over their tailnet), for GUI work
there: Xcode, Safari, Figma. Only when the owner asks for their Mac, call \`mac_desktop\` and send them the link; it
lasts two hours.`,

  async tools(ctx) {
    const baseUrl = `https://${ctx.env("TAILNET_HOST")}:9443`;
    return localTools([
      {
        name: "mac_desktop",
        description: "Open a live browser session (VNC) to the owner's home Mac and get its link, valid for two hours. Only when the owner asks for their Mac.",
        input: input({ note: optional(str("What it's for, shown at the top of the page.")) }),
        async run(args) {
          const id = randomBytes(12).toString("hex");
          sessions.set(id, { id, createdAt: Date.now(), note: args.note ? String(args.note) : undefined });
          return text(`${baseUrl}/mac/${id}`);
        },
      },
    ]);
  },

  async start(ctx) {
    const host = ctx.env("MAC_VNC_HOST");
    const port = Number(process.env.MAC_VNC_BACKEND_PORT ?? 6080);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, id, rest = ""] = ROUTE.exec(url.pathname) ?? [];
      const s = id ? session(id) : undefined;
      if (!s) return void res.writeHead(404).end();
      if (!rest) {
        const expires = new Date(s.createdAt + TTL_MS).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page(s.id, expires, s.note));
      }
      if (!rest.startsWith("/vnc/")) return void res.writeHead(404).end();
      const upstream = request({ host, port, method: req.method, path: rest.slice(4) + url.search, headers: { ...req.headers, host: `${host}:${port}` } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end("Can't reach the Mac."));
      req.pipe(upstream);
    });

    // noVNC's WebSocket, piped to websockify on the Mac with only the path and Host rewritten.
    server.on("upgrade", (req, socket, head) => {
      const [, id, rest] = ROUTE.exec(new URL(req.url ?? "/", "http://localhost").pathname) ?? [];
      if (!id || !session(id) || rest !== "/ws") return socket.destroy();
      const upstream = connect(port, host, () => {
        const headers = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i].toLowerCase() !== "host") headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`GET /websockify HTTP/1.1\r\nHost: ${host}:${port}\r\n${headers.join("\r\n")}\r\n\r\n`);
        upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });

    server.listen(PORT, "127.0.0.1");
  },
} satisfies Plugin;
