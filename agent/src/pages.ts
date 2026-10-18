import { defineTool } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

// Web pages the agent makes (a comparison, an itinerary, a chart) and texts as a link. They're files under an
// unguessable name. Preview tags are added here, so a texted link expands into a card with a title, summary and image.

const PREVIEW_IMAGE = "https://images.unsplash.com/photo-1685397166172-0308e96ee012?fm=jpg&q=80&w=1200&h=630&fit=crop";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function pageTool(dir: string, baseUrl: string) {
  mkdirSync(dir, { recursive: true });
  // The preview image lives next to the pages (the biscotti photo by Geertje Caliguire on Unsplash).
  if (!existsSync(`${dir}/preview.jpg`))
    void fetch(PREVIEW_IMAGE)
      .then((r) => r.arrayBuffer())
      .then((b) => writeFileSync(`${dir}/preview.jpg`, Buffer.from(b)))
      .catch(() => {});

  return defineTool({
    name: "publish_page",
    label: "Publish page",
    description:
      "Publish a self-contained HTML page (inline CSS/JS, phone-friendly) and get its link. Use it when an answer is better as a page than a text: tables, comparisons, itineraries, charts. The link is sent to the user as its own message, which expands into a card with the title and summary.",
    parameters: Type.Object({
      title: Type.String({ description: "The page's name, shown on the link card." }),
      summary: Type.String({ description: "One sentence for the link card." }),
      html: Type.String({ description: "A complete HTML document." }),
    }),
    async execute(_id, { title, summary, html }) {
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
      return { content: [{ type: "text" as const, text: `${baseUrl}/${name}` }], details: {} };
    },
  });
}
