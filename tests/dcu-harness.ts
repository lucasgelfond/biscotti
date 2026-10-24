import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { createGate } from "../core/src/gate.ts";
import { openDb } from "../core/src/memory.ts";
import type { Context } from "../core/src/plugin.ts";
import vault, { secrets } from "../core/src/vault.ts";
import dcu from "../plugins/discriminative-computer-use/index.ts";
import secureFill from "../plugins/secure-fill/index.ts";
import vision from "../plugins/vision/index.ts";
import { chrome, newDataDir } from "./support.ts";

// discriminative-computer-use as a task VM runs it, on this machine: a headless Chrome for the VM's browser, a gate
// listening as slot 1 with the vault, secure-fill, vision (locate needs GROUNDING_API_KEY) and the plugin, and vm.ts
// as its own process. `approve` answers each of the gate's questions.

const env = (name: string) => {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name]!;
};

export async function harness(port: number, approve: (question: string) => boolean = () => true) {
  const page = await chrome(port, "about:blank", ["--window-size=1280,900"]);
  const browser = page.url;
  process.env.TASK_BROWSER = browser;

  const dir = newDataDir();
  const db = openDb(`${dir}/biscotti.db`, "test-key");
  const asked: string[] = [];
  const gate = createGate({
    llm: { url: env("LLM_BASE_URL"), key: env("LLM_API_KEY") },
    models: { task: env("TASK_MODEL") },
    send: async (t) => {
      if (!/Reply yes or no/.test(t)) return;
      asked.push(t);
      setTimeout(() => gate.answer(approve(t) ? "yes" : "no"), 10);
    },
    secrets: () => secrets(db),
  });
  const ctx: Context = { db, dir, env, ask: gate.ask, deliver: async () => {}, send: async () => {}, task: async () => ({ report: "" }) };
  for (const plugin of [vault, secureFill, dcu, vision]) gate.add(await plugin.tools!(ctx));
  const server: Server = await gate.listen("127.0.0.1", port + 1, { slot: 1, peer: "127.0.0.1" });

  return {
    db,
    asked,
    async errand(goal: string, url?: string) {
      const runner = spawn(process.execPath, [new URL("../plugins/discriminative-computer-use/vm.ts", import.meta.url).pathname], {
        env: { ...process.env, GATE_URL: `http://127.0.0.1:${port + 1}`, BROWSER_URL: browser },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let out = "";
      runner.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      runner.stdin.end(JSON.stringify({ goal, url }));
      await once(runner, "close");
      return out.trim().split("\n").at(-1) ?? "";
    },
    close() {
      server.close();
      page.close();
    },
  };
}
