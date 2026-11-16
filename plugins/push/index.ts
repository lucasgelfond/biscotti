import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appMethod, taskEvents, type Plugin } from "@biscotti/core";
import { ApnsClient, Errors, Notification } from "apns2";

// Push notifications to the owner's phones (the Concourse app, in the dotfiles) when a task reports or fails, straight to Apple's APNs with a
// token key. Settings: APNS_KEY_FILE (the .p8 from the Apple developer site), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC
// (the app's bundle ID). Phones register with the apps' devices.register method {token,
// sandbox} (a development build's token is a sandbox one), and are kept in the data directory.

export default {
  async start(ctx) {
    const file = `${ctx.dir}/devices.json`;
    let devices: { token: string; sandbox: boolean }[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const save = () => writeFileSync(file, JSON.stringify(devices));
    const { APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = process.env;
    const configured = Boolean(APNS_KEY_FILE && APNS_KEY_ID && APNS_TEAM_ID && APNS_TOPIC && existsSync(APNS_KEY_FILE));
    const client = (sandbox: boolean) =>
      new ApnsClient({ team: APNS_TEAM_ID!, keyId: APNS_KEY_ID!, signingKey: readFileSync(APNS_KEY_FILE!), defaultTopic: APNS_TOPIC!, host: sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com" });
    const clients = configured ? { true: client(true), false: client(false) } : undefined;
    // A token the phone no longer has (the app was deleted) is forgotten.
    const forget = (err: { notification: { deviceToken: string } }) => ((devices = devices.filter((d) => d.token !== err.notification.deviceToken)), save());
    for (const c of Object.values(clients ?? {})) {
      c.on(Errors.badDeviceToken, forget);
      c.on(Errors.unregistered, forget);
      c.on(Errors.error, (err: { reason?: string }) => console.error(`push: ${err.reason}`));
    }

    taskEvents.on("event", (e) => {
      if (!clients || (e.type !== "report" && e.type !== "failed")) return;
      const alert = { title: `Task #${e.id} ${e.type === "report" ? "reported" : "failed"}`, body: (e.text ?? "").slice(0, 400) };
      for (const d of devices) void clients[`${d.sandbox}`].send(new Notification(d.token, { alert, sound: "default", threadId: `task-${e.id}`, data: { task: e.id } })).catch(() => {});
    });

    appMethod("devices.register", async ({ token, sandbox }) => {
      if (typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token)) throw new Error("not a device token");
      devices = [...devices.filter((d) => d.token !== token), { token, sandbox: Boolean(sandbox) }];
      save();
      return { push: configured };
    });
  },
} satisfies Plugin;
