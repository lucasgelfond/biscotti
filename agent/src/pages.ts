import { defineTool } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

// Web pages the agent makes (a comparison, an itinerary, a chart) and texts as a link. They're files under an
// unguessable name, served only on the owner's tailnet.
export function pageTool(dir: string, baseUrl: string) {
  mkdirSync(dir, { recursive: true });
  return defineTool({
    name: "publish_page",
    label: "Publish page",
    description:
      "Publish a self-contained HTML page (inline CSS/JS, phone-friendly) and get a private link to text the user. Use it when an answer is better as a page than a text: tables, comparisons, itineraries, charts.",
    parameters: Type.Object({ html: Type.String({ description: "A complete HTML document." }) }),
    async execute(_id, { html }) {
      const name = `${randomBytes(12).toString("hex")}.html`;
      writeFileSync(`${dir}/${name}`, html);
      return { content: [{ type: "text" as const, text: `${baseUrl}/${name}` }], details: {} };
    },
  });
}
