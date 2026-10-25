import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";

// A stand-in for EverydayBench's control port: run "r1" has one follow-up due, given once; "old" is an EverydayBench
// from before follow-ups (a 404). Set before everydaybench.ts reads where the control port is.
let asked = 0;
const control = createServer((req, res) => {
  if (req.url === "/runs/r1/followups") {
    asked++;
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(asked === 1 ? [{ id: "f1", text: "wait, make it 4 people" }] : []));
  }
  res.writeHead(404).end("not found");
}).listen(0, "127.0.0.1");
await once(control, "listening");
process.env.EVERYDAYBENCH_CONTROL = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
const { followups } = await import("./everydaybench.ts");

test("the bench gets a run's due follow-ups once, and none from an EverydayBench without them or out of reach", async () => {
  expect(await followups("r1")).toEqual([{ id: "f1", text: "wait, make it 4 people" }]);
  expect(await followups("r1")).toEqual([]);
  expect(await followups("old")).toEqual([]);
  control.close();
  expect(await followups("r1")).toEqual([]);
});
