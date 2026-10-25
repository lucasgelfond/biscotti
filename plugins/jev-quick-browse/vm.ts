// The errand's runner inside the task VM: the errand on stdin, the report as the last line out. Everything goes
// through the gate: Jev's decisions (the gate holds the key), the writing model (secrets kept out), and the vault
// (which asks the owner before every fill).
import { browse, type Vault } from "./loop.ts";

const GATE = process.env.GATE_URL ?? "http://gate";
const BROWSER = process.env.BROWSER_URL ?? "http://127.0.0.1:9222";

// One tool call on the gate's MCP endpoint (stateless, so no session to open first).
async function tool(name: string, args: object) {
  const res = await fetch(`${GATE}/mcp`, {
    // A fill waits for the owner's answer (up to 10 minutes).
    signal: AbortSignal.timeout(name === "vault_fill" ? 11 * 60_000 : 60_000),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.text();
  const message = JSON.parse(body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  if (message.error) throw new Error(`${name}: ${message.error.message}`);
  return (message.result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
}

async function write(instructions: string, packet: object) {
  const res = await fetch(`${GATE}/llm/chat/completions`, {
    signal: AbortSignal.timeout(120_000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "task", messages: [{ role: "system", content: instructions }, { role: "user", content: JSON.stringify(packet) }] }),
  });
  if (!res.ok) throw new Error(`the writing model: ${res.status}`);
  return String((await res.json()).choices[0].message.content ?? "").trim();
}

// vault_list's lines: "Name: field, field (value), …".
const vault: Vault = {
  async list() {
    const lines = (await tool("vault_list", {})).split("\n").filter((l) => l.includes(": "));
    return lines.map((l) => {
      const at = l.indexOf(": ");
      return { name: l.slice(0, at), fields: l.slice(at + 2).split(", ").map((f) => f.replace(/ \(.*\)$/, "")) };
    });
  },
  fill: (name, fields, why) => tool("vault_fill", { name, fields, why }),
};

// The errand, as the plugin sent it: { goal, url?, values? } (values: text to type, by what it's for).
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { goal, url, values } = JSON.parse(input) as { goal: string; url?: string; values?: Record<string, string> };
// An answer is JSON; anything else is the error (a request too long for Jev, say), for the loop to act on.
const decide = async (state: object, questions: object, assets?: object) => {
  const said = await tool("jev_decide", { state, questions, ...(assets && { assets }) });
  if (!said.trimStart().startsWith("{")) throw new Error(said.slice(0, 300));
  return JSON.parse(said);
};
const { report, outcome, steps, requirements } = await browse(goal, BROWSER, { decide, write, vault, values, log: console.error }, url).catch((err: Error) => ({
  report: `Browsing failed: ${err.message}`,
  outcome: "error",
  steps: [],
  requirements: [] as { requirement: string; met: boolean }[],
}));
const unmet = requirements.filter((r) => !r.met).map((r) => r.requirement);
const met = `${requirements.length - unmet.length}/${requirements.length} requirements met${unmet.length ? `; not met: ${unmet.join("; ")}` : ""}`;
console.log(`${report} (${outcome}, ${steps.length} steps, ${met})`.replace(/\n/g, " "));
