import { input, int, list, localTools, secrets, str, text, type CallToolResult, type LocalTool, type Plugin } from "@biscotti/core";
import { browser, devtools, targets } from "../secure-fill/index.ts";

// Seeing the page better: zoom into a region at full detail, and locate an element by description with a model trained
// for clicking (any OpenAI-compatible endpoint serving one; H Company's Holo by default). Both work in the page's
// coordinates, the ones browser_mouse_click_xy takes. The gate takes the screenshots, so a locate sends only the page
// and the description, never the goal; it refuses while a saved secret is anywhere in the page.

// A zoom's longest side, in pixels.
const ZOOM_SIZE = 1280;

async function viewport(url: string) {
  const page = (await targets(url)).find((t) => t.type === "page");
  if (!page) throw new Error("no browser tab is open");
  const tab = await devtools(url, page);
  const { cssVisualViewport: v }: { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } } = await tab.send("Page.getLayoutMetrics");
  // A region of the visible page (in its coordinates), scaled.
  const shot = async (x: number, y: number, width: number, height: number, scale = 1): Promise<string> =>
    (await tab.send("Page.captureScreenshot", { format: "png", clip: { x: v.pageX + x, y: v.pageY + y, width, height, scale } })).data;
  return { width: v.clientWidth, height: v.clientHeight, shot, close: tab.close };
}

// Whether any saved secret is in the page: its text or its inputs, in every frame (card fields often sit in another
// site's frame).
async function holdsSecret(url: string, values: string[]) {
  if (!values.length) return false;
  const frames = (await targets(url)).filter((t) => t.type === "page" || t.type === "iframe");
  for (const frame of frames) {
    const tab = await devtools(url, frame);
    try {
      const { result } = await tab.send("Runtime.evaluate", {
        expression: `[document.body?.innerText ?? "", ...[...document.querySelectorAll("input, textarea")].map((el) => el.value)].join("\\n")`,
        returnByValue: true,
      });
      if (values.some((v) => String(result.value).includes(v))) return true;
    } finally {
      tab.close();
    }
  }
  return false;
}

const image = (data: string, note: string): CallToolResult => ({ content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: note }] });

export default {
  async tools(ctx) {
    const zoom: LocalTool = {
      name: "zoom",
      description:
        "Zoom into a region of the browser's visible page, in the coordinates of browser_take_screenshot and browser_mouse_click_xy, to read small text or check exactly where something is before clicking it.",
      input: input({ region: list(int(), "[x0, y0, x1, y1]: the region's top-left and bottom-right corners.") }),
      async run({ region }, { slot }) {
        const view = await viewport(browser(slot));
        try {
          if (!Array.isArray(region) || region.length !== 4) return text("The region is [x0, y0, x1, y1].");
          const [x0, y0, x1, y1] = region.map((n) => Math.round(Number(n)));
          const [x, y] = [Math.max(0, x0), Math.max(0, y0)];
          const [width, height] = [Math.min(view.width, x1) - x, Math.min(view.height, y1) - y];
          if (!(width > 0 && height > 0)) return text(`That region is off the page, which is ${view.width}x${view.height}.`);
          const scale = Math.min(4, ZOOM_SIZE / Math.max(width, height));
          return image(await view.shot(x, y, width, height, scale), `The region (${x},${y})-(${x + width},${y + height}), ${scale.toFixed(1)}x.`);
        } finally {
          view.close();
        }
      },
    };
    const { GROUNDING_API_KEY: key, GROUNDING_URL = "https://api.hcompany.ai/v1", GROUNDING_MODEL = "holo3-1-35b-a3b" } = process.env;
    const locate: LocalTool = {
      name: "locate",
      description:
        "Find where to click: describe one element as you'd tell a person (\"the 7:40 PM showtime under 'Anora'\", \"seat F12 in the seat map\") and get its x, y in the visible page, for browser_mouse_click_xy. For things the page snapshot doesn't give a ref for: canvases, seat maps, maps, custom widgets.",
      input: input({ target: str("The element, with enough context to tell it apart from similar ones.") }),
      async run({ target }, { slot }) {
        if (await holdsSecret(browser(slot), secrets(ctx.db).map((s) => s.value))) return text("Not while a saved secret is in the page. Use the page snapshot instead.");
        const view = await viewport(browser(slot));
        let png: string;
        try {
          png = await view.shot(0, 0, view.width, view.height);
        } finally {
          view.close();
        }
        const schema = { type: "object", properties: { x: { type: "integer", minimum: 0, maximum: 1000 }, y: { type: "integer", minimum: 0, maximum: 1000 } }, required: ["x", "y"] };
        const res = await fetch(`${GROUNDING_URL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: GROUNDING_MODEL,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
                  { type: "text", text: `Localize an element on the GUI image according to the provided target and output a click position.\nYou must output a valid JSON following the format: ${JSON.stringify(schema)}\nYour target is: ${String(target).slice(0, 300)}` },
                ],
              },
            ],
            structured_outputs: { json: schema },
            chat_template_kwargs: { enable_thinking: false },
          }),
        });
        if (!res.ok) return text(`Couldn't locate it: ${res.status} ${(await res.text()).slice(0, 200)}`);
        const answer = (await res.json()).choices?.[0]?.message?.content ?? "";
        const point = JSON.parse(answer.match(/\{[^}]*\}/)?.[0] ?? "null");
        if (!(Number.isFinite(point?.x) && Number.isFinite(point?.y))) return text(`Couldn't locate it: ${answer.slice(0, 200)}`);
        const [x, y] = [Math.round((point.x / 1000) * view.width), Math.round((point.y / 1000) * view.height)];
        return text(`${x}, ${y} (in a ${view.width}x${view.height} page). Zoom there to check before clicking if it matters.`);
      },
    };
    return { ...localTools([]), tasks: localTools(key ? [zoom, locate] : [zoom]) };
  },
} satisfies Plugin;
