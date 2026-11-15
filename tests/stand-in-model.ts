import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// The stand-in model, OpenAI chat completions streamed: "remember X" calls the remember tool, a tool result is
// answered with "saved", anything else is echoed.
export const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
export const model = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body) as (typeof requests)[number];
  requests.push(request);
  const last = request.messages.at(-1)!;
  const said = typeof last.content === "string" ? last.content : (last.content as { text?: string }[]).map((p) => p.text ?? "").join("");
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage && { usage }) })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const remember = said.match(/remember (.+)$/)?.[1];
  if (last.role === "tool") res.write(chunk({ role: "assistant", content: "saved" }) + chunk({}, "stop", { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 }));
  else if (remember)
    res.write(
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: remember }) } }] }) +
        chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    );
  else res.write(chunk({ role: "assistant", content: `echo: ${said.replace(/^\[[^\]]*\] /, "")}` }) + chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }));
  res.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await once(model, "listening");
Object.assign(process.env, {
  LLM_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  LLM_API_KEY: "stand-in",
  MODEL: "stand-in/model",
  TASK_MODEL: "stand-in/model",
  DB_KEY: "test-key",
  // No owner API on a port: tests and the dev host reach the agent's socket directly.
  API_PORT: "0",
});
export const standInModel = model;
