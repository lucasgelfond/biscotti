import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boardStore, taskBoard } from "../core/src/board.ts";
import { openDb } from "../core/src/memory.ts";
import { taskEvents } from "../core/src/tasks.ts";

test("keeps tasks and boxes in the database across a restart, numbering on from the last", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "board-")), "biscotti.db"), "test");
  const store = boardStore(db);
  const board = taskBoard(undefined, store);
  const at = Date.now();
  taskEvents.emit("event", { id: 4, type: "queued", goal: "fix the bug", at });
  taskEvents.emit("event", { id: 4, type: "report", text: "done", at: at + 1 });
  taskEvents.emit("event", { id: 5, type: "queued", goal: "Box on o/r", kind: "box", repo: "o/r", at: at + 2 });
  taskEvents.emit("event", { id: 5, type: "step", kind: "box", ssh: { host: "h", port: 2201, user: "cua" }, preview: "https://p", text: "Ready", at: at + 3 });
  expect(board.list().map((t) => t.id)).toEqual([5, 4]);

  const again = taskBoard(undefined, boardStore(db));
  expect(again.get(4)).toMatchObject({ goal: "fix the bug", report: "done", kind: "task" });
  expect(again.get(5)).toMatchObject({ kind: "box", repo: "o/r", ssh: { port: 2201 }, preview: "https://p" });
  expect(store.lastId()).toBe(5);
});

test("lists a kept box from before the database as a box, with its repo", () => {
  const board = taskBoard(() => [{ id: 9, goal: "Box on o/r", slot: 1, at: 1 }]);
  expect(board.list().find((t) => t.id === 9)).toMatchObject({ kind: "box", repo: "o/r", status: "kept" });
});
