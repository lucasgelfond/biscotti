import { expect, test } from "vitest";
import { sshEndpoint } from "../core/src/boxes.ts";
import { nodeHosts, vmEndpoint } from "../core/src/plugin.ts";

test("routes each slot to its machine: local slots to their link, cloud slot 100k+n to machine k's forwards", () => {
  nodeHosts.set(1, "biscotti-node-1.tail.ts.net");
  nodeHosts.set(3, "biscotti-node-3.tail.ts.net");
  expect(vmEndpoint(2, 4000)).toEqual({ host: "10.200.2.2", port: 4000 });
  expect(vmEndpoint(101, 4000)).toEqual({ host: "biscotti-node-1.tail.ts.net", port: 14001 });
  expect(vmEndpoint(304, 9223)).toEqual({ host: "biscotti-node-3.tail.ts.net", port: 19204 });
  expect(sshEndpoint(302)).toEqual({ host: "biscotti-node-3.tail.ts.net", port: 12202, user: "cua" });
});
