import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { localTools, text, type Plugin } from "@biscotti/core";

// Pages the agent texts as links. Public (Funnel) under unguessable names, so iMessage can fetch the preview tags.

const PORT = 8082;
// The biscotti photo by Geertje Caliguire on Unsplash.
const PREVIEW_IMAGE = "https://images.unsplash.com/photo-1685397166172-0308e96ee012?fm=jpg&q=80&w=1200&h=630&fit=crop";
const NAME = /^\/([0-9a-f]{24}\.html|preview\.jpg)$/;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export default {
  prompt: `Pages: when an answer is better as a page (a table, comparison, itinerary, chart), make a self-contained,
phone-friendly HTML page with \`publish_page\`. Put its link on a line of its own at the end of your reply; it's sent
as a separate message that expands into a card, so keep the rest of the reply to a line or two.`,

  async tools(ctx) {
    const dir = `${ctx.dir}/pages`;
    const baseUrl = process.env.PAGES_URL ?? `https://${ctx.env("TAILNET_HOST")}`;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(`${dir}/preview.jpg`))
      void fetch(PREVIEW_IMAGE)
        .then((r) => r.arrayBuffer())
        .then((b) => writeFileSync(`${dir}/preview.jpg`, Buffer.from(b)))
        .catch(() => {});

    return localTools([
      {
        name: "publish_page",
        description:
          "Publish a self-contained HTML page (inline CSS/JS, phone-friendly) and get its link. Use it when an answer is better as a page than a text: tables, comparisons, itineraries, charts. The link is sent to the user as its own message, which expands into a card with the title and summary.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "The page's name, shown on the link card." },
            summary: { type: "string", description: "One sentence for the link card." },
            html: { type: "string", description: "A complete HTML document." },
          },
          required: ["title", "summary", "html"],
        },
        async run(args) {
          const { title, summary, html } = args as { title: string; summary: string; html: string };
          const name = `${randomBytes(12).toString("hex")}.html`;
          const tags = [
            `<title>${escape(title)}</title>`,
            `<meta property="og:title" content="${escape(title)}">`,
            `<meta property="og:description" content="${escape(summary)}">`,
            `<meta property="og:image" content="${baseUrl}/preview.jpg">`,
            `<meta property="og:type" content="website">`,
            `<meta name="viewport" content="width=device-width, initial-scale=1">`,
          ].join("\n");
          const withTags = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}\n${tags}`) : `<head>${tags}</head>${html}`;
          writeFileSync(`${dir}/${name}`, withTags);
          return text(`${baseUrl}/${name}`);
        },
      },
    ]);
  },

  async start(ctx) {
    const dir = `${ctx.dir}/pages`;
    createServer((req, res) => {
      const name = NAME.exec(req.url ?? "")?.[1];
      if (!name || !existsSync(`${dir}/${name}`)) return void res.writeHead(404).end();
      // Public pages on the owner's hostname: sandboxed (no access to anything else on it) and kept out of search.
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "image/jpeg",
        "Content-Security-Policy": "sandbox allow-scripts allow-popups",
        "X-Robots-Tag": "noindex",
      });
      res.end(readFileSync(`${dir}/${name}`));
    }).listen(Number(process.env.PAGES_PORT ?? PORT), "127.0.0.1");
  },
} satisfies Plugin;
