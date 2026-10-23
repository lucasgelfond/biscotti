import type { CallToolResult, Observer, Plugin } from "@biscotti/core";
import { SpanStatusCode, trace, ROOT_CONTEXT, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

// Traces of every turn, model call and tool call, as OpenTelemetry spans with OpenInference attributes (what Phoenix
// shows prompts, replies and tokens from) and GenAI ones (Langfuse, Braintrust, …). They go to the Phoenix in
// compose.yaml, or to OTEL_EXPORTER_OTLP_ENDPOINT (and _HEADERS) when that's set.

// A task VM's calls are one trace until its slot has been quiet this long.
const TASK_IDLE_MS = 2 * 60_000;

type Message = { role: string; content?: unknown; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id?: string; function?: { name?: string; arguments?: string } };

const json = (v: unknown) => JSON.stringify(v);
const contentText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n") : "";

function messageAttributes(prefix: string, messages: Message[]): Attributes {
  const out: Attributes = {};
  messages.forEach((m, i) => {
    const at = `${prefix}.${i}.message`;
    out[`${at}.role`] = m.role;
    out[`${at}.content`] = contentText(m.content);
    if (m.tool_call_id) out[`${at}.tool_call_id`] = m.tool_call_id;
    m.tool_calls?.forEach((c, j) => {
      out[`${at}.tool_calls.${j}.tool_call.id`] = c.id ?? "";
      out[`${at}.tool_calls.${j}.tool_call.function.name`] = c.function?.name ?? "";
      out[`${at}.tool_calls.${j}.tool_call.function.arguments`] = c.function?.arguments ?? "";
    });
  });
  return out;
}

// The reply from a chat completion, streamed (server-sent events) or not.
export function completion(body: string) {
  type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  if (!body.trimStart().startsWith("data:")) {
    const { choices, usage } = JSON.parse(body) as { choices?: { message: Message }[]; usage?: Usage };
    return { message: choices?.[0]?.message ?? { role: "assistant" }, usage };
  }
  const message: Message & { content: string } = { role: "assistant", content: "" };
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  for (const line of body.split("\n")) {
    const data = line.match(/^data: ?(.*)$/)?.[1];
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string; tool_calls?: (ToolCall & { index: number })[] } }[]; usage?: Usage };
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    message.content += delta?.content ?? "";
    for (const c of delta?.tool_calls ?? []) {
      const call = (calls[c.index] ??= { function: { name: "", arguments: "" } });
      if (c.id) call.id = c.id;
      call.function!.name += c.function?.name ?? "";
      call.function!.arguments += c.function?.arguments ?? "";
    }
  }
  if (calls.length) message.tool_calls = calls;
  return { message, usage };
}

const fail = (span: Span, error: unknown) => {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
};

// An observer must never throw into the gate: neither a hook nor what it returns.
function safe<A extends unknown[], R extends unknown[]>(hook: (...args: A) => (...result: R) => void) {
  const guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error("phoenix:", err);
    }
  };
  return guard((...args: A) => guard(hook(...args))) as (...args: A) => (...result: R) => void;
}

export function observer(tracer: Tracer): Observer {
  // The main agent's calls belong to its oldest open turn (a message mid-reply opens one that steers it); a task VM's
  // to its slot's task.
  const turns: Span[] = [];
  const tasks = new Map<number, { span: Span; pending: number; last: number; timer?: NodeJS.Timeout; goal?: boolean }>();

  function parentOf(slot?: number) {
    if (slot === undefined) return turns[0] && trace.setSpan(ROOT_CONTEXT, turns[0]);
    let task = tasks.get(slot);
    if (!task) {
      task = { span: tracer.startSpan("task", { attributes: { "openinference.span.kind": "AGENT", "biscotti.slot": slot } }, ROOT_CONTEXT), pending: 0, last: Date.now() };
      tasks.set(slot, task);
    }
    clearTimeout(task.timer);
    task.pending++;
    return trace.setSpan(ROOT_CONTEXT, task.span);
  }

  function settled(slot?: number, output?: string) {
    const task = slot !== undefined && tasks.get(slot);
    if (!task) return;
    task.pending--;
    task.last = Date.now();
    if (output) task.span.setAttribute("output.value", output);
    if (task.pending) return;
    task.timer = setTimeout(() => {
      task.span.end(task.last);
      tasks.delete(slot);
    }, TASK_IDLE_MS);
  }

  return {
    turn: safe((message: string) => {
      const span = tracer.startSpan("turn", { attributes: { "openinference.span.kind": "AGENT", "session.id": "biscotti", "input.value": message } }, ROOT_CONTEXT);
      turns.push(span);
      return (reply?: string, error?: unknown) => {
        if (reply) span.setAttribute("output.value", reply);
        if (error) fail(span, error);
        span.end();
        turns.splice(turns.indexOf(span), 1);
      };
    }),

    llm: safe(({ slot, model, request }: { slot?: number; model: string; request: Record<string, unknown> }) => {
      const { messages = [], tools = [], ...params } = request as { messages?: Message[]; tools?: { function?: unknown }[] };
      const parent = parentOf(slot);
      // A task's goal is its first model call's first user message.
      const task = slot !== undefined && tasks.get(slot);
      if (task && !task.goal) {
        task.span.setAttribute("input.value", contentText(messages.find((m) => m.role === "user")?.content));
        task.goal = true;
      }
      const span = tracer.startSpan(
        `llm ${model}`,
        {
          attributes: {
            "openinference.span.kind": "LLM",
            "llm.model_name": model,
            "llm.invocation_parameters": json(params),
            "input.value": json(messages),
            "input.mime_type": "application/json",
            ...messageAttributes("llm.input_messages", messages),
            ...Object.fromEntries(tools.map((t, i) => [`llm.tools.${i}.tool.json_schema`, json(t)])),
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            ...(slot !== undefined && { "biscotti.slot": slot }),
          },
        },
        parent,
      );
      return ({ status, body }: { status: number; body: string }) => {
        let text: string | undefined;
        try {
          if (status >= 400) throw new Error(`${status}: ${body.slice(0, 2000)}`);
          const { message, usage } = completion(body);
          text = contentText(message.content);
          span.setAttributes({
            "output.value": text || json(message.tool_calls ?? []),
            ...messageAttributes("llm.output_messages", [message]),
            ...(usage && {
              "llm.token_count.prompt": usage.prompt_tokens,
              "llm.token_count.completion": usage.completion_tokens,
              "llm.token_count.total": usage.total_tokens,
              "llm.token_count.prompt_details.cache_read": usage.prompt_tokens_details?.cached_tokens,
              "gen_ai.usage.input_tokens": usage.prompt_tokens,
              "gen_ai.usage.output_tokens": usage.completion_tokens,
            }),
          });
        } catch (err) {
          fail(span, err);
        } finally {
          span.end();
          settled(slot, text);
        }
      };
    }),

    tool: safe(({ name, args, slot }: { name: string; args: Record<string, unknown>; slot?: number }) => {
      const span = tracer.startSpan(
        name,
        {
          attributes: {
            "openinference.span.kind": "TOOL",
            "tool.name": name,
            "tool.parameters": json(args),
            "input.value": json(args),
            "input.mime_type": "application/json",
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            ...(slot !== undefined && { "biscotti.slot": slot }),
          },
        },
        parentOf(slot),
      );
      return (result?: CallToolResult, error?: unknown) => {
        if (result) span.setAttribute("output.value", result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"));
        if (result?.isError) span.setStatus({ code: SpanStatusCode.ERROR });
        if (error) fail(span, error);
        span.end();
        settled(slot);
      };
    }),
  };
}

export function tracerFor(exporter: SpanExporter) {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "biscotti", "openinference.project.name": "biscotti" }),
    // A model call carries the whole conversation, one attribute per message part.
    spanLimits: { attributeCountLimit: 100_000 },
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer("biscotti"), provider };
}

export default {
  async observe() {
    const env = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const exporter = new OTLPTraceExporter(env ? {} : { url: "http://127.0.0.1:6006/v1/traces" });
    return observer(tracerFor(exporter).tracer);
  },
} satisfies Plugin;
