import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const dl = `https://dl.biscotti.lucasgelfond.online/v${version}`;
const files = ["installer.zip", "pi5.img.zst", "mac.qcow2.zst", "aws.vhd.zst"];

// Short links (/biscotti-pi5.img.zst, …) go to the current version's files.
const redirects = {
  name: "redirects",
  generateBundle() {
    const lines = files.flatMap((f) => {
      const [name, ext] = [f.slice(0, f.indexOf(".")), f.slice(f.indexOf("."))];
      const to = `${dl}/biscotti-${name}-v${version}${ext}`;
      return [`/biscotti-${f} ${to} 302`, `/biscotti-${f}.sha256 ${to}.sha256 302`];
    });
    this.emitFile({ type: "asset", fileName: "_redirects", source: lines.join("\n") + "\n" });
  },
};

export default defineConfig({ plugins: [svelte(), redirects], base: "./", define: { __VERSION__: JSON.stringify(version) } });
