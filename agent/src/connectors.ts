import { createMcpExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)\b/i;

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
          config: { url, headers: { Authorization: `Bearer ${token}` }, exposure: "direct" },
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
