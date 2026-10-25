import { devtools, targets } from "../../plugins/secure-fill/index.ts";

// A restored VM's browser can take a few seconds to answer.
async function ready(browser: string) {
  for (let i = 0; ; i++) {
    try {
      return await targets(browser);
    } catch (err) {
      if (i === 30) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// A page loaded in the browser at `browser` (a DevTools address, the one the gate uses for a VM), and its <pre> text.
export async function open(browser: string, url: string) {
  const tab = await devtools(browser, (await ready(browser)).find((t) => t.type === "page")!);
  try {
    await tab.send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { result } = await tab.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (result.value === "complete") break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    const { result } = await tab.send("Runtime.evaluate", { expression: 'document.querySelector("pre")?.innerText ?? ""', returnByValue: true });
    return String(result.value);
  } finally {
    tab.close();
  }
}
