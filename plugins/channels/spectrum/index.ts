import type { Channel, Plugin } from "@biscotti/core";
import { attachment, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

// iMessage through Photon's Spectrum. Only the owner's texts come through.
export async function connect(env: (name: string) => string): Promise<Channel> {
  const app = await Spectrum({
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    providers: [imessage.config()],
  });
  const im = imessage(app);
  const owner = env("OWNER");
  const space = await im.space.create(await im.user(owner));

  async function* messages() {
    for await (const [, message] of app.messages) {
      if (message.direction === "outbound" || message.content.type !== "text") continue;
      if (message.sender?.id !== owner) {
        console.warn(`ignoring message from ${message.sender?.id}`);
        continue;
      }
      yield { text: message.content.text, react: (emoji: string) => message.react(emoji) };
    }
  }

  return {
    messages: messages(),
    async send(m) {
      await space.send("text" in m ? m.text : attachment(m.image, { mimeType: "image/png", name: "screen.png" }));
    },
  };
}

export default { channel: (ctx) => connect(ctx.env) } satisfies Plugin;
