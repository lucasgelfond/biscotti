import { expect, test } from "vitest";
import { startFakeGoogle } from "./fakes/google.ts";
import { boot, toolCalls } from "./support.ts";

// The Google plugin against a fake Google: sign-in by texted link, reads, and writes that wait for the owner's yes.
const FAKE_PORT = 8097;
const CALLBACK_PORT = 4892;
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  GOOGLE_API_URL: `http://127.0.0.1:${FAKE_PORT}`,
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${FAKE_PORT}/token`,
  GOOGLE_PORT: String(CALLBACK_PORT),
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`,
});
const google = startFakeGoogle(FAKE_PORT);
const biscotti = boot(["google"]);

// As after a sign-in, for tests that don't do one.
async function connected() {
  const b = await biscotti;
  b.db.$client.prepare("INSERT OR REPLACE INTO google_auth VALUES (1, 'fake-refresh')").run();
  b.sent.length = 0;
  return b;
}

test("connects Google through a texted sign-in link", async () => {
  const { say, sent, db } = await biscotti;

  await say("Connect my Google account please.");
  const link = sent.join("\n").match(/https:\/\/accounts\.google\.com\/\S+/)?.[0];
  const params = new URL(link!).searchParams;
  const before = sent.length;
  const callback = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/oauth/callback?code=the-code&state=${params.get("state")}`);
  const forged = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/oauth/callback?code=the-code&state=wrong`);
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(before);

  const stored = db.$client.prepare("SELECT refresh_token FROM google_auth").get();
  expect(params.get("access_type")).toBe("offline");
  expect(params.get("scope")).toContain("gmail.modify");
  expect(callback.status).toBe(200);
  expect(forged.status).toBe(404);
  expect(google.tokenRequests[0].get("code")).toBe("the-code");
  expect(stored).toEqual({ refresh_token: "fake-refresh" });
});

test("answers from the inbox and the calendar", async () => {
  const { say, sent, db } = await connected();

  await say("When is my dentist appointment, and how much is rent?");

  const calls = toolCalls(db).flat();
  expect(calls.some((n) => n.endsWith("gmail_search") || n.endsWith("calendar_events"))).toBe(true);
  expect(sent.join("\n")).toMatch(/3:30/);
  expect(sent.join("\n")).toContain("2,400");
});

test("asks before sending an email, and sends it on a yes", async () => {
  const { say, sent } = await connected();

  const replied = say("Send an email to sam@example.com thanking them for lunch today.");
  await expect.poll(() => sent.join("\n"), { timeout: 60_000 }).toContain("Reply yes or no");
  await say("yes");
  await replied;

  expect(google.sent).toHaveLength(1);
  expect(google.sent[0]).toContain("To: sam@example.com");
  expect(google.sent[0].toLowerCase()).toContain("lunch");
});

test("asks before deleting an event, and keeps it on a no", async () => {
  const { say, sent } = await connected();

  const replied = say("Delete my dinner with Sam from my calendar.");
  await expect.poll(() => sent.join("\n"), { timeout: 60_000 }).toContain("Reply yes or no");
  await say("no");
  await replied;

  expect(sent).toContain("Declined.");
  expect(google.events.map((e) => e.id)).toContain("e2");
});
