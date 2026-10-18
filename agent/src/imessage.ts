import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

// Photon's cloud iMessage, with the owner's conversation opened up front so the agent can text first.
export async function connectIMessage(env: (name: string) => string) {
  const app = await Spectrum({
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    providers: [imessage.config()],
  });
  const im = imessage(app);
  const ownerSpace = await im.space.create(await im.user(env("OWNER")));
  return { app, ownerSpace };
}
