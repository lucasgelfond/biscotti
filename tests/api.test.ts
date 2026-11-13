import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { startApi } from "../core/src/api.ts";
import { taskBoard } from "../core/src/board.ts";
import { taskEvents } from "../core/src/tasks.ts";

// The app's API over a board fed by task events, with stand-in actions.
test("lists tasks, streams their events, and takes actions, for the owner only", async () => {
  process.env.API_OWNER = "owner@github";
  const board = taskBoard();
  const told: string[] = [];
  const server = await startApi(board, {
    start: async (goal) => (told.push(`start ${goal}`), 7),
    tell: (id, message) => (told.push(`tell ${id} ${message}`), "told"),
    stop: (id) => (told.push(`stop ${id}`), true),
    move: (id) => (told.push(`move ${id}`), "moving"),
    watch: async () => undefined,
  }, undefined, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const as = { "Tailscale-User-Login": "owner@github" };

  expect((await fetch(`${base}/tasks`)).status).toBe(403);
  expect((await fetch(`${base}/tasks`, { headers: { "Tailscale-User-Login": "someone@else" } })).status).toBe(403);

  const at = Date.now();
  taskEvents.emit("event", { id: 1, type: "queued", goal: "find flights", at });
  taskEvents.emit("event", { id: 1, type: "started", slot: 101, where: "cloud", at });
  const { tasks } = await (await fetch(`${base}/tasks`, { headers: as })).json();
  expect(tasks[0]).toMatchObject({ id: 1, goal: "find flights", status: "running", where: "cloud" });

  // The stream: the list first, then each event.
  const stream = await fetch(`${base}/events`, { headers: as });
  const reader = stream.body!.getReader();
  let got = "";
  const until = async (s: string) => {
    while (!got.includes(s)) got += new TextDecoder().decode((await reader.read()).value);
  };
  await until("event: tasks");
  taskEvents.emit("event", { id: 1, type: "step", tool: "browser_navigate", text: "{}", at: Date.now() });
  await until("browser_navigate");
  await reader.cancel();
  expect((await (await fetch(`${base}/tasks/1`, { headers: as })).json()).steps.at(-1).tool).toBe("browser_navigate");

  const post = (path: string, body?: object) => fetch(`${base}${path}`, { method: "POST", headers: { ...as, "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
  expect(await post("/tasks", { goal: "book it" })).toEqual({ id: 7 });
  expect(await post("/tasks/1/tell", { message: "two seats" })).toEqual({ result: "told" });
  expect(await post("/tasks/1/stop")).toEqual({ stopped: true });
  expect(await post("/tasks/1/move")).toEqual({ result: "moving" });
  expect(told).toEqual(["start book it", "tell 1 two seats", "stop 1", "move 1"]);
  server.close();
});
