import { input, int, list, localTools, text, type CallToolResult, type LocalTool, type Plugin } from "@biscotti/core";
import { browser, devtools, targets } from "../secure-fill/index.ts";

// Seeing the page better: zoom into a region at full detail, in the page's coordinates (the ones browser_mouse_click_xy
// takes).

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

const image = (data: string, note: string): CallToolResult => ({ content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: note }] });

export default {
  async tools() {
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
    return { ...localTools([]), tasks: localTools([zoom]) };
  },
} satisfies Plugin;
