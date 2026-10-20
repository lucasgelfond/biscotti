import { input, localTools, str, text, type Channel, type Plugin } from "@biscotti/core";
import { attachment, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

// iMessage through Photon's Spectrum. Only the owner's one-on-one texts come through, never their group chats.

type Reactable = { react(emoji: string): Promise<unknown> };

// A link on its own line goes as its own message, so it expands into a preview.
export function asTexts(reply: string) {
  const lines = reply.split("\n");
  const isLink = (line: string) => /^https?:\/\/\S+$/.test(line.trim());
  const body = lines.filter((l) => !isLink(l)).join("\n").trim();
  return [...(body ? [body] : []), ...lines.filter(isLink).map((l) => l.trim())];
}

// Tapbacks on the owner's latest text.
export function tapbacks() {
  let latest: Reactable | undefined;
  return {
    seen: (message: Reactable) => void (latest = message),
    tools: localTools([
      {
        name: "react",
        description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
        input: input({ emoji: str() }),
        async run({ emoji }) {
          await latest?.react(String(emoji));
          return text("Reacted.");
        },
      },
    ]),
  };
}

export async function connect(env: (name: string) => string, seen: (message: Reactable) => void = () => {}): Promise<Channel & { close(): Promise<void> }> {
  const app = await Spectrum({
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    providers: [imessage.config()],
  });
  const im = imessage(app);
  const owner = env("OWNER");
  const space = await im.space.create(await im.user(owner));

  async function* messages() {
    for await (const [chat, message] of app.messages) {
      if (message.direction === "outbound" || message.content.type !== "text") continue;
      const group = (chat as { type?: string }).type === "group" || chat.id.includes(";+;");
      if (message.sender?.id !== owner || group) {
        console.warn(`ignoring message from ${message.sender?.id}${group ? " in a group chat" : ""}`);
        continue;
      }
      seen(message);
      yield { text: message.content.text };
    }
  }

  // Close the connection on shutdown: Photon keeps delivering to a dropped one for a while, so the next one hears nothing.
  const close = () => app.stop();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void close().finally(() => process.exit(0)));

  return {
    close,
    messages: messages(),
    async send(m) {
      if ("image" in m) return void (await space.send(attachment(m.image, { mimeType: "image/png", name: "screen.png" })));
      for (const t of asTexts(m.text)) await space.send(t);
    },
  };
}

const tapback = tapbacks();
export default {
  prompt: "A tapback (`react`) is a fine acknowledgment or answer on its own.",
  channel: (ctx) => connect(ctx.env, tapback.seen),
  tools: async () => tapback.tools,
} satisfies Plugin;
