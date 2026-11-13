import { sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";

// Push notifications to the owner's phones (the iOS app, apps/ios), straight to Apple's APNs with a token key: no
// other server. APNS_KEY_FILE (the .p8 from the Apple developer site), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (the app's
// bundle ID). Devices register through the API (api.ts) and are kept in DATA_DIR/devices.json.
interface Device {
  token: string;
  sandbox: boolean;
}

export function pusher(dataDir?: string) {
  const { APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = process.env;
  const file = dataDir && `${dataDir}/devices.json`;
  let devices: Device[] = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const save = () => file && writeFileSync(file, JSON.stringify(devices));
  const configured = Boolean(APNS_KEY_FILE && APNS_KEY_ID && APNS_TEAM_ID && APNS_TOPIC && existsSync(APNS_KEY_FILE));

  // Apple's token: an ES256 JWT, good for an hour; made again after 50 minutes.
  let jwt: { token: string; at: number } | undefined;
  const token = () => {
    if (jwt && Date.now() - jwt.at < 50 * 60_000) return jwt.token;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${b64({ alg: "ES256", kid: APNS_KEY_ID })}.${b64({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
    const signature = sign("sha256", Buffer.from(body), { key: readFileSync(APNS_KEY_FILE!, "utf8"), dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = { token: `${body}.${signature}`, at: Date.now() };
    return jwt.token;
  };

  function send(device: Device, payload: object) {
    return new Promise<void>((resolve) => {
      const client = connect(device.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
      client.on("error", (err) => (console.error(`push: ${err.message}`), resolve()));
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${token()}`,
        "apns-topic": APNS_TOPIC!,
        "apns-push-type": "alert",
      });
      let status = 0;
      let reply = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (d) => (reply += d));
      req.on("end", () => {
        // A token the phone no longer has (the app was deleted): forgotten.
        if (status === 410 || /BadDeviceToken|Unregistered/.test(reply)) ((devices = devices.filter((d) => d.token !== device.token)), save());
        else if (status !== 200) console.error(`push: ${status} ${reply}`);
        client.close();
        resolve();
      });
      req.on("error", () => (client.close(), resolve()));
      req.end(JSON.stringify(payload));
    });
  }

  return {
    configured,
    register(token: string, sandbox: boolean) {
      if (!/^[0-9a-f]{32,200}$/i.test(token)) throw new Error("not a device token");
      devices = [...devices.filter((d) => d.token !== token), { token, sandbox }];
      save();
    },
    // One alert to every registered phone, grouped by task.
    async notify(title: string, body: string, task?: number) {
      if (!configured || !devices.length) return;
      const payload = { aps: { alert: { title, body: body.slice(0, 400) }, sound: "default", ...(task && { "thread-id": `task-${task}` }) }, task };
      await Promise.all(devices.map((d) => send(d, payload)));
    },
  };
}
