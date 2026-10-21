import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { escapeHtml, input, localTools, PAGE_ART, PAGE_STYLE, str, text, type Plugin } from "@biscotti/core";

// Pages the agent texts as links. Public (Funnel) under unguessable names, so iMessage can fetch the preview tags.

const PORT = 8082;
// The biscotti photo by Geertje Caliguire on Unsplash.
const PREVIEW_IMAGE = "https://images.unsplash.com/photo-1685397166172-0308e96ee012?fm=jpg&q=80&w=1200&h=630&fit=crop";
const NAME = /^\/([0-9a-f]{24}\.html|preview\.jpg)$/;

// biscotti's look under the page's own CSS: plain HTML (headings, tables, lists) comes out styled, and a page can
// still restyle anything.
const LOOK = `<style>
${PAGE_STYLE}
body{max-width:720px;margin:0 auto;padding:40px 16px 64px;box-sizing:border-box}
h2,h3{font-size:15px;font-weight:600;margin:32px 0 12px}
table{border-collapse:collapse;display:block;overflow-x:auto;margin:0 0 24px}
th,td{border:1px solid #000;padding:6px 10px;text-align:left;vertical-align:top}
th{font-weight:600}
ul,ol{padding-left:20px}
img{max-width:100%}
</style>`;

const SELF_CONTAINED = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

export default {
  prompt: `Pages: when an answer is better as a page (a table, comparison, itinerary, chart), make a self-contained,
phone-friendly HTML page with \`publish_page\`: everything inline (images as data: URLs), since pages can't load
anything. Pages come in biscotti's look (monospace, black on white, its header), so write plain HTML (headings,
tables, lists) and add CSS only where a page needs it. Put its link on a line of its own at the end of your reply; it's sent as a separate message that expands
into a card, so keep the rest of the reply to a line or two.`,

  async tools(ctx) {
    const dir = `${ctx.dir}/pages`;
    const baseUrl = `https://${ctx.env("TAILNET_HOST")}`;
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
          "Publish a self-contained HTML page (inline CSS/JS/images; it can load nothing from elsewhere; phone-friendly) and get its link. Use it when an answer is better as a page than a text: tables, comparisons, itineraries, charts. The link is sent to the user as its own message, which expands into a card with the title and summary.",
        input: input({
          title: str("The page's name, shown on the link card."),
          summary: str("One sentence for the link card."),
          html: str("A complete HTML document."),
        }),
        async run(args) {
          const { title, summary, html } = args as { title: string; summary: string; html: string };
          const name = `${randomBytes(12).toString("hex")}.html`;
          const tags = [
            `<title>${escapeHtml(title)}</title>`,
            `<meta property="og:title" content="${escapeHtml(title)}">`,
            `<meta property="og:description" content="${escapeHtml(summary)}">`,
            `<meta property="og:image" content="${baseUrl}/preview.jpg">`,
            `<meta property="og:type" content="website">`,
            `<meta name="viewport" content="width=device-width, initial-scale=1">`,
            LOOK,
          ].join("\n");
          const withTags = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}\n${tags}`) : `<head>${tags}</head>${html}`;
          const page = /<body[^>]*>/i.test(withTags) ? withTags.replace(/<body[^>]*>/i, (b) => `${b}${PAGE_ART}`) : withTags.replace(/<\/head>/i, (h) => `${h}${PAGE_ART}`);
          writeFileSync(`${dir}/${name}`, page);
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
      // Public pages on the owner's hostname: sandboxed (no access to anything else on it), kept out of search, and
      // self-contained: a page can't load or send anything, so one written from a poisoned web page can't phone home.
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "image/jpeg",
        "Content-Security-Policy": `sandbox allow-scripts allow-popups; ${SELF_CONTAINED}`,
        "X-Robots-Tag": "noindex",
      });
      res.end(readFileSync(`${dir}/${name}`));
    }).listen(Number(process.env.PAGES_PORT ?? PORT), "127.0.0.1");
  },
} satisfies Plugin;
