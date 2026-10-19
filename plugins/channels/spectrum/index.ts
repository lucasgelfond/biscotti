import type { Channel, Plugin } from "@biscotti/core";
import { attachment, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

// iMessage through Photon's Spectrum. Only the owner's texts in their one-on-one chat come through: what they say in
// a group chat is meant for the others there, never for biscotti (or one of its questions).
export async function connect(env: (name: string) => string): Promise<Channel & { close(): Promise<void> }> {
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
      yield { text: message.content.text, react: (emoji: string) => message.react(emoji) };
    }
  }

  // Close the connection on shutdown: Photon keeps delivering to a dropped one for a while, so the next one hears nothing.
  const close = () => app.stop();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void close().finally(() => process.exit(0)));

  return {
    close,
    messages: messages(),
    async send(m) {
      await space.send("text" in m ? m.text : attachment(m.image, { mimeType: "image/png", name: "screen.png" }));
    },
  };
}

export default { channel: (ctx) => connect(ctx.env) } satisfies Plugin;
