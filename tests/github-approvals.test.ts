import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test, vi } from "vitest";
import type { Context, Plugin } from "../core/src/plugin.ts";
import { approvals, reposSaid } from "../plugins/github/approvals.ts";
import { testContext } from "./support.ts";

// Which GitHub calls go ahead without the owner's yes, which keep it, and the audit line each one that went ahead
// leaves. GitHub's own MCP server and API are stood in for, so nothing here touches github.com.

const TOKEN = "github-token-1";
const REPO = "lucasgelfond/biscotti";

// GitHub's MCP server: a read, a branch, two ways to commit a file, a pull request, a comment, a deletion, an issue,
// settings and a merge; and the API's default branch for a repo.
const calls: { name: string; args: Record<string, unknown> }[] = [];
const http = createServer(async (req, res) => {
  const repo = /^\/repos\/([\w.-]+\/[\w.-]+)$/.exec((req.url ?? "").split("?")[0]);
  if (repo) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ full_name: repo[1], default_branch: "main" }));
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
  const server = new Server({ name: "github", version: "1" }, { capabilities: { tools: {} } });
  const schema = { type: "object" as const, properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } } };
  const tool = (name: string, readOnly: boolean) => ({ name, description: name, inputSchema: schema, annotations: { readOnlyHint: readOnly } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("get_me", true),
      tool("list_branches", true),
      tool("create_branch", false),
      tool("create_or_update_file", false),
      tool("create_pull_request", false),
      tool("add_issue_comment", false),
      tool("request_reviewers", false),
      tool("issue_write", false),
      tool("delete_file", false),
      tool("update_repo_settings", false),
      tool("merge_pull_request", false),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    calls.push({ name: params.name, args: (params.arguments ?? {}) as Record<string, unknown> });
    return { content: [{ type: "text", text: `${params.name} ok` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(0, "127.0.0.1");
await once(http, "listening");
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
Object.assign(process.env, { GITHUB_TOKEN: TOKEN, GITHUB_MCP_URL: `${url}/mcp`, GITHUB_API_URL: url });
const plugin = (await import("../plugins/github/index.ts")).default;

afterEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
});

// The plugin as biscotti loads it: a fresh gate's context (so a fresh session), what the owner was asked, and the
// audit lines. `answer` is the owner's yes or no.
async function github(answer = () => true) {
  const asked: string[] = [];
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
  const ctx = testContext({ ask: async (q) => (asked.push(q), answer()) }) as Context;
  // The owner's own message, and what biscotti delivered, as the gate hands them to every plugin's observer.
  const observer = await (plugin as Plugin).observe!(ctx);
  const said = (text: string) => observer.turn!(text, { owner: true });
  const reported = (text: string) => observer.turn!(text, {});
  return { tools: await plugin.tools!(ctx), asked, logged, said, reported };
}

const commit = (branch: string, repo = "biscotti") => ({ owner: "lucasgelfond", repo, path: "src/a.ts", content: "x", message: "fix", branch });

test("reads, branches, commits off the default branch, pull requests, comments and review requests go ahead, one audit line each", async () => {
  const { tools, asked, logged } = await github();

  await tools.call("get_me", {});
  await tools.call("create_branch", { owner: "lucasgelfond", repo: "biscotti", branch: "biscotti/fix-tests" });
  await tools.call("create_or_update_file", commit("biscotti/fix-tests"));
  await tools.call("create_pull_request", { owner: "lucasgelfond", repo: "biscotti", head: "biscotti/fix-tests", base: "main", title: "Fix" });
  await tools.call("add_issue_comment", { owner: "lucasgelfond", repo: "biscotti", issue_number: 7, body: "+1" });
  await tools.call("request_reviewers", { owner: "lucasgelfond", repo: "biscotti", pull_number: 7 });

  expect(asked).toEqual([]);
  expect(calls.map((c) => c.name)).toEqual(["get_me", "create_branch", "create_or_update_file", "create_pull_request", "add_issue_comment", "request_reviewers"]);
  expect(logged).toEqual([
    `github: auto-approved get_me`,
    `github: auto-approved create_branch on ${REPO} (branch biscotti/fix-tests)`,
    `github: auto-approved create_or_update_file on ${REPO} (branch biscotti/fix-tests)`,
    `github: auto-approved create_pull_request on ${REPO} (branch biscotti/fix-tests)`,
    `github: auto-approved add_issue_comment on ${REPO}`,
    `github: auto-approved request_reviewers on ${REPO}`,
  ]);
});

test("deleting, writing the default branch, settings and anything unrecognized keep the prompt, and a no still makes none", async () => {
  const { tools, asked, logged } = await github(() => false);

  await tools.call("delete_file", { owner: "lucasgelfond", repo: "biscotti", path: "src/a.ts", branch: "main", message: "rm" });
  await tools.call("create_or_update_file", commit("main"));
  await tools.call("update_repo_settings", { owner: "lucasgelfond", repo: "biscotti", visibility: "public" });
  await tools.call("issue_write", { owner: "lucasgelfond", repo: "biscotti", title: "Flaky test" });

  expect(asked).toHaveLength(4);
  expect(asked[0]).toContain("delete_file");
  expect(asked[1]).toContain("create_or_update_file");
  expect(asked[2]).toContain("update_repo_settings");
  expect(asked[3]).toContain("issue_write");
  expect(calls).toEqual([]);
  expect(logged).toEqual([]);
});

test("there is no merge to decide: the tool is left out", async () => {
  const { tools } = await github();

  const names = (await tools.list()).map((t) => t.name);

  expect(names).not.toContain("merge_pull_request");
  expect(names).toEqual(expect.arrayContaining(["create_pull_request", "delete_file", "get_me", "code_task"]));
});

test("a repo the owner asked for work on this conversation goes ahead for the rest of the session, its default branch still doesn't", async () => {
  const { tools, asked, said, reported } = await github();

  // An issue is a change biscotti can't tell the shape of by name: it asks until the owner has named the repo.
  await tools.call("issue_write", { owner: "lucasgelfond", repo: "biscotti", title: "Flaky test" });
  // A report is data, not the owner asking for anything, however many repos it names.
  await reported(`Task report (check ${REPO}): green now.`);
  await tools.call("issue_write", { owner: "lucasgelfond", repo: "biscotti", title: "Flaky test" });
  expect(asked).toHaveLength(2);

  await said(`Fix the flaky test in ${REPO} please.`);
  const before = calls.length;
  await tools.call("issue_write", { owner: "lucasgelfond", repo: "biscotti", title: "Flaky test" });
  expect(calls.length - before).toBe(1);
  // Another repo isn't covered.
  await tools.call("issue_write", { owner: "lucasgelfond", repo: "something-else", title: "Flaky test" });
  // Nor is anything that takes something away, nor the default branch.
  await tools.call("delete_file", { owner: "lucasgelfond", repo: "biscotti", path: "src/a.ts", branch: "biscotti/fix", message: "rm" });
  await tools.call("create_or_update_file", commit("main"));

  expect(asked).toHaveLength(5);
  expect(asked[4]).toContain("create_or_update_file");
  expect(calls[before]).toEqual({ name: "issue_write", args: { owner: "lucasgelfond", repo: "biscotti", title: "Flaky test" } });
});

test("finds the repos the owner names, in a link or bare", () => {
  expect(reposSaid(`Fix it in ${REPO} please.`)).toEqual([REPO]);
  expect(reposSaid("Look at https://github.com/LucasGelfond/Biscotti/pull/12.")).toEqual([REPO]);
  expect(reposSaid("Clone git@github.com:lucasgelfond/biscotti.git")).toEqual([REPO]);
  expect(reposSaid("nothing to see here")).toEqual([]);
});

test("a commit whose branch can't be compared to the default asks, unless the owner asked for work in that repo", async () => {
  const logged: string[] = [];
  // No default branch to look up: nothing says this branch isn't the default one.
  const alone = approvals({ log: (line) => void logged.push(line) });
  const call = { tool: "create_or_update_file", args: { owner: "lucasgelfond", repo: "biscotti", branch: "feature", path: "a", content: "x", message: "m" } };

  expect((await alone.decide(call)).risk).toBe("gated");
  alone.note(`work on ${REPO} please`);
  expect((await alone.decide(call)).risk).toBe("safe");
  expect(logged).toEqual([`github: auto-approved create_or_update_file on ${REPO} (branch feature)`]);
});
