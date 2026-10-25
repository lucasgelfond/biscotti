// /biscotti-lean [level]: a smaller request for each of the task model's calls, for small models and for cost. biscotti-task runs
// it when the host asks (after /biscotti-reload, which starts extensions afresh).
// - Tools: the ones task agents use, declared; the rest (the desktop's, rarer browser ones) left out.
// - Views of the page: all but the latest few snapshots and screenshots become a one-line note. They go a batch at a
//   time, so the start of the conversation stays the same between batches and the provider's prompt cache keeps working.
// - At level 2 (`/biscotti-lean 2`), long results of other tools (a script's output, a page's text) keep only their
//   start and end once newer results have come in, the same way.

type Content = { type: string; text?: string };
type Message = { role: string; toolName?: string; toolCallId?: string; content?: Content[] | string };
type Payload = { tools?: { name?: string; function?: { name: string } }[] } & Record<string, unknown>;
type Pi = {
  registerCommand(name: string, options: { description: string; handler(args: string): Promise<void> }): void;
  on(event: "context", handler: (event: { messages: Message[] }) => { messages?: Message[] } | void): void;
  on(event: "before_provider_request", handler: (event: { payload: Payload }) => Payload | void): void;
  getAllTools(): { name: string }[];
  setActiveTools(names: string[]): void;
};

const BROWSER = ["navigate", "navigate_back", "snapshot", "click", "type", "fill_form", "select_option", "press_key", "run_code_unsafe", "evaluate", "take_screenshot", "find", "mouse_click_xy", "mouse_wheel", "tabs", "handle_dialog", "wait_for", "file_upload"];
const KEPT = new Set(["read", "bash", "edit", "write", ...BROWSER.map((t) => `mcp__browser__browser_${t}`)]);
// The gate's tools (the vault, sharing a screenshot, plugins' task tools) all stay.
const kept = (name: string) => KEPT.has(name) || name.startsWith("mcp__biscotti__");

// The latest views kept whole, and how many more may pile up before a batch becomes notes.
const LATEST = 2;
const BATCH = 4;
const NOTE = "(An earlier view of the page, left out to keep the conversation short. Take a snapshot or screenshot to see the page now.)";
// Level 2: an older result longer than this keeps its start and end.
const LONG = 2_500;
const clipped = (text: string) => `${text.slice(0, 1_500)}\n… (${text.length - 2_000} characters of this earlier result left out) …\n${text.slice(-500)}`;

const isView = (m: Message) =>
  m.role === "toolResult" &&
  (/browser_(snapshot|take_screenshot)|zoom/.test(m.toolName ?? "") || (Array.isArray(m.content) && m.content.some((c) => c.type === "image")));

export default function (pi: Pi) {
  let on = false;
  let level = 1;
  const noted = new Set<string>();
  const cut = new Set<string>();
  pi.registerCommand("biscotti-lean", {
    description: "Fewer tools and only recent views of the page in each model call",
    handler: async (args) => {
      on = true;
      level = Number(args.trim()) || 1;
      pi.setActiveTools(pi.getAllTools().map((t) => t.name).filter(kept));
    },
  });
  // MCP servers that reconnect after the reload declare their tools again: the request itself is what counts.
  pi.on("before_provider_request", ({ payload }) => {
    if (!on || !payload.tools) return;
    return { ...payload, tools: payload.tools.filter((t) => kept(t.function?.name ?? t.name ?? "")) };
  });
  pi.on("context", ({ messages }) => {
    if (!on) return;
    const views = messages.filter((m) => isView(m) && m.toolCallId && !noted.has(m.toolCallId));
    if (views.length > LATEST + BATCH) for (const m of views.slice(0, -LATEST)) noted.add(m.toolCallId!);
    const text = (m: Message) => (Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("\n") : (m.content ?? ""));
    if (level >= 2) {
      const long = messages.filter((m) => m.role === "toolResult" && m.toolCallId && !isView(m) && !cut.has(m.toolCallId) && text(m).length > LONG);
      if (long.length > LATEST + BATCH) for (const m of long.slice(0, -LATEST)) cut.add(m.toolCallId!);
    }
    return {
      messages: messages.map((m) =>
        m.role !== "toolResult" || !m.toolCallId ? m
        : noted.has(m.toolCallId) ? { ...m, content: [{ type: "text", text: NOTE }] }
        : cut.has(m.toolCallId) ? { ...m, content: [{ type: "text", text: clipped(text(m)) }] }
        : m,
      ),
    };
  });
}
