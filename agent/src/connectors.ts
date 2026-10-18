import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)\b/i;
export const NO = /^(no|nope|n|don't|do not|stop|cancel|decline)\b/i;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("");
}

// Executor's tools over MCP. Calls that need approval pause, and the agent resumes them with the owner's answer
// (Executor's default "model" elicitation mode). The agent can't approve on its own: accepting is allowed only when
// the owner's latest text is a yes, and each yes approves one request.
export function executor(url: string, token: string): ExtensionFactory[] {
  const mcp = createMcpExtension({
    loadConfig: () => ({
      servers: [
        {
          name: "executor",
          source: "biscotti",
          scope: "extension",
          config: { url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` }, exposure: "direct" },
        },
      ],
      errors: [],
    }),
  });

  const usedYes = new Set<string>();
  const approvals: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "mcp__executor__resume") return;
      // Fail closed: only declining or cancelling needs no yes.
      const action = (event.input as { response?: { action?: string } }).response?.action;
      if (action === "decline" || action === "cancel") return;
      const latest = ctx.sessionManager
        .getBranch()
        .flatMap((e) => (e.type === "message" && e.message.role === "user" ? [{ id: e.id, content: e.message.content }] : []))
        .at(-1);
      // User messages start with the "[time] " prefix agent.reply adds.
      const said = latest ? text(latest.content).replace(/^\[[^\]]*\]\s*/, "") : "";
      if (latest && YES.test(said) && !usedYes.has(latest.id)) {
        usedYes.add(latest.id);
        return;
      }
      return { block: true, reason: "Approval needs the owner's own yes. Ask them by text, then resume after they reply." };
    });
  };

  return [mcp, approvals];
}

// Catalog apps the agent uses; the owner connects their accounts to them.
const APPS = ["google", "github"];

async function json(res: Promise<Response>) {
  const r = await res;
  if (!r.ok) throw new Error(`executor ${new URL(r.url).pathname}: ${r.status} ${await r.text()}`);
  return r.json();
}

// On a fresh Executor: creates the owner's admin account and a token for the agent (kept in the agent's data volume),
// then installs the catalog apps. Requests that manage auth must carry Executor's own origin.
export async function ensureExecutorToken(
  url: string,
  origin: string,
  tokenFile: string,
  admin: { name: string; email: string; password: string },
): Promise<string> {
  if (existsSync(tokenFile)) return readFileSync(tokenFile, "utf8");
  const { setup } = await json(fetch(`${url}/api/auth/self-host/config`));
  if (!setup) throw new Error("Executor is already set up: create an API key in its UI and set EXECUTOR_API_KEY");

  const headers = { "Content-Type": "application/json", Origin: origin };
  const signup = await fetch(`${url}/api/auth/self-host/setup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...admin, organizationName: "biscotti" }),
  });
  if (!signup.ok) throw new Error(`executor setup: ${signup.status} ${await signup.text()}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const [{ id: organization }] = await json(fetch(`${url}/api/auth/organization/list`, { headers: { cookie } }));
  const { key } = await json(
    fetch(`${url}/api/auth/api-key/create`, {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ name: "biscotti agent", metadata: { organization } }),
    }),
  );
  for (const entry of APPS)
    await json(
      fetch(`${url}/api/organizations/${organization}/apps/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ entry, name: entry }),
      }),
    );
  writeFileSync(tokenFile, key, { mode: 0o600 });
  return key;
}
