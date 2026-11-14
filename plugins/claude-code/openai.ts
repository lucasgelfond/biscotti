// OpenAI chat completions <-> Claude Code's stream-json: the conversation as Anthropic messages (frames) for `claude -p`,
// and its Anthropic stream events back as an OpenAI completion or SSE chunks. Ported from pi-claude-code
// (github.com/earendil-works/pi-claude-code, MIT, src/transcript.ts and src/claude-cli.ts).

// The inert MCP server Claude Code knows the tools by: it names them mcp__<server>__<tool>.
export const SERVER = "gate";
const PREFIX = `mcp__${SERVER}__`;
const unprefixed = (name: unknown) => (String(name).startsWith(PREFIX) ? String(name).slice(PREFIX.length) : String(name));

type Json = Record<string, unknown>;
type Part = { type: string; text?: string; image_url?: { url: string } | string };
export interface ChatMessage {
  role: string;
  content?: string | Part[] | null;
  tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
  tool_call_id?: string;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type?: string; function: { name: string; description?: string; parameters?: Json } }[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
}
export interface Frame {
  type: "user" | "assistant";
  message: { role: "user" | "assistant"; content: Json[] };
  shouldQuery?: false;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
}

const clean = (s: string) => s.replace(/[\uD800-\uDFFF]/gu, "�");
// Anthropic's tool_use ids are [a-zA-Z0-9_-]{1,64}; other providers' (in an older history) may not be.
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";

function image(url: string): Json {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return data ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } } : { type: "image", source: { type: "url", url } };
}

function parts(content: ChatMessage["content"]): Json[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: clean(content) }] : [];
  return content.flatMap((p): Json[] => {
    if (p.type === "text") return p.text ? [{ type: "text", text: clean(p.text) }] : [];
    if (p.type === "image_url" && p.image_url) return [image(typeof p.image_url === "string" ? p.image_url : p.image_url.url)];
    return [{ type: "text", text: `[${p.type} not supported]` }];
  });
}

const text = (content: ChatMessage["content"]) =>
  parts(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text as string)
    .join("\n");

// Signed thinking can't ride along in OpenAI messages, so the replies that had it are kept here, by what the caller
// will send back (the tool calls' ids, or the text), and replayed as they were: Anthropic wants the thinking of a tool
// call's turn back with its result.
const replies = new Map<string, Json[]>();
const replyKey = (text: string, toolIds: string[]) => (toolIds.length ? `tools:${toolIds.join(",")}` : `text:${text.trim()}`);
export function remember(content: Json[]) {
  if (!content.some((b) => b.type === "thinking" || b.type === "redacted_thinking")) return;
  const said = content.flatMap((b) => (b.type === "text" ? [b.text as string] : [])).join("");
  replies.set(replyKey(said, content.flatMap((b) => (b.type === "tool_use" ? [b.id as string] : []))), content);
  if (replies.size > 500) replies.delete(replies.keys().next().value!);
}

function assistant(m: ChatMessage): Json[] {
  const said = text(m.content);
  const calls = m.tool_calls ?? [];
  const kept = replies.get(replyKey(said, calls.map((c) => toolId(c.id))));
  if (kept) return kept;
  const args = (s?: string) => {
    try {
      const v = JSON.parse(s || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  };
  return [
    ...(said.trim() ? [{ type: "text", text: clean(said) }] : []),
    ...calls.map((c) => ({ type: "tool_use", id: toolId(c.id), name: PREFIX + c.function.name, input: args(c.function.arguments) })),
  ];
}

// The system prompt, and the rest as frames: each user frame but the last is history (shouldQuery: false).
export function frames(messages: ChatMessage[]): { system: string; frames: Frame[] } {
  const system: string[] = [];
  const out: Frame[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      system.push(text(m.content));
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks =
      m.role === "assistant"
        ? assistant(m)
        : m.role === "tool"
          ? [{ type: "tool_result", tool_use_id: toolId(m.tool_call_id ?? ""), content: parts(m.content).length ? parts(m.content) : "(no output)" }]
          : parts(m.content);
    if (!blocks.length) continue;
    const last = out.at(-1);
    if (last?.type === role) last.message.content.push(...blocks);
    else out.push({ type: role, message: { role, content: blocks } });
  }
  if (out.at(-1)?.type !== "user") throw new Error("the conversation must end with a user or tool message");
  for (const f of out.slice(0, -1)) if (f.type === "user") f.shouldQuery = false;
  return { system: system.join("\n\n"), frames: out };
}

// Loose JSON Schema simplified for Anthropic's input_schema (pi-claude-code's normalizeInputSchema).
function schema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(schema);
  if (!node || typeof node !== "object") return node;
  const out: Json = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, schema(v)]));
  if (Array.isArray(out.type) && out.type.includes("null")) {
    const rest = out.type.filter((t) => t !== "null");
    out.type = rest.length === 1 ? rest[0] : rest;
  }
  return out;
}

export function tools(req: ChatRequest): Tool[] {
  return (req.tools ?? []).map(({ function: f }) => {
    const input = schema(f.parameters ?? {}) as Json;
    for (const k of ["oneOf", "allOf", "anyOf"]) delete input[k];
    if (!input.type) input.type = "object";
    if (input.type === "object" && (!input.properties || typeof input.properties !== "object")) input.properties = {};
    return { name: f.name, description: f.description ?? "", inputSchema: input };
  });
}

const FINISH: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "content_filter" };

// Anthropic stream events in, OpenAI chunks out (`chunk`), and the whole reply as it stands (`message`, `completion`).
export function translator(model: string) {
  let id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const content: Json[] = [];
  const json = new Map<number, string>();
  const toolIndex = new Map<number, number>();
  let usage = { input: 0, cached: 0, output: 0 };
  let finish: string | null = null;

  const chunk = (delta: Json, finish_reason: string | null = null, extra: Json = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  });
  const openaiUsage = () => ({
    prompt_tokens: usage.input + usage.cached,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.cached + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cached },
  });
  const addUsage = (u?: Json) => {
    if (!u) return;
    if (typeof u.input_tokens === "number") usage.input = u.input_tokens + (Number(u.cache_creation_input_tokens) || 0);
    if (typeof u.cache_read_input_tokens === "number") usage.cached = u.cache_read_input_tokens;
    if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
  };

  return {
    // The chunks for one event, if any.
    event(e: Json): Json[] {
      switch (e.type) {
        case "message_start": {
          const m = e.message as Json;
          if (m.id) id = `chatcmpl-${m.id}`;
          addUsage(m.usage as Json);
          return [chunk({ role: "assistant", content: "" })];
        }
        case "content_block_start": {
          const index = e.index as number;
          const block = structuredClone(e.content_block as Json);
          content[index] = block;
          if (block.type !== "tool_use") return [];
          const n = toolIndex.size;
          toolIndex.set(index, n);
          json.set(index, "");
          return [chunk({ tool_calls: [{ index: n, id: block.id, type: "function", function: { name: unprefixed(block.name), arguments: "" } }] })];
        }
        case "content_block_delta": {
          const index = e.index as number;
          const block = content[index];
          const d = e.delta as Json;
          if (!block) return [];
          if (d.type === "text_delta") {
            block.text = String(block.text ?? "") + d.text;
            return [chunk({ content: d.text })];
          }
          if (d.type === "thinking_delta") {
            block.thinking = String(block.thinking ?? "") + d.thinking;
            return [chunk({ reasoning_content: d.thinking })];
          }
          if (d.type === "signature_delta") block.signature = String(block.signature ?? "") + d.signature;
          if (d.type === "input_json_delta") {
            json.set(index, (json.get(index) ?? "") + d.partial_json);
            return [chunk({ tool_calls: [{ index: toolIndex.get(index), function: { arguments: d.partial_json } }] })];
          }
          return [];
        }
        case "content_block_stop": {
          const index = e.index as number;
          const block = content[index];
          if (block?.type === "tool_use" && json.has(index)) {
            const raw = json.get(index)!.trim();
            block.input = raw ? JSON.parse(raw) : {};
          }
          return [];
        }
        case "message_delta": {
          const d = e.delta as Json;
          if (d?.stop_reason) finish = FINISH[d.stop_reason as string] ?? "stop";
          addUsage(e.usage as Json);
          return [];
        }
        case "message_stop":
          remember(content.filter(Boolean));
          return [chunk({}, finish ?? "stop", { usage: openaiUsage() })];
        default:
          return [];
      }
    },
    completion() {
      const blocks = content.filter(Boolean);
      const said = blocks.flatMap((b) => (b.type === "text" ? [b.text as string] : [])).join("");
      const thought = blocks.flatMap((b) => (b.type === "thinking" ? [b.thinking as string] : [])).join("");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: unprefixed(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: said || null, ...(thought && { reasoning_content: thought }), ...(calls.length && { tool_calls: calls }) },
            finish_reason: finish ?? "stop",
          },
        ],
        usage: openaiUsage(),
      };
    },
  };
}
