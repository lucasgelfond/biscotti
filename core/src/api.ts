import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { taskBoard } from "./board.ts";
import type { boxes } from "./boxes.ts";
import type { pusher } from "./push.ts";
import { taskEvents, type TaskEvent } from "./tasks.ts";

// The task API, for the iOS app (apps/ios) and the multiplexer: the task list, a live stream of what tasks do (server-
// sent events), and starting, telling, stopping and moving tasks. It listens on localhost only; `tailscale serve`
// publishes it on the tailnet (nix/setup.nix), which names the person on each request (Tailscale-User-Login). Only the
// owner's login (API_OWNER, e.g. you@github) may use it; without API_OWNER, anyone on the tailnet signed in as a person
// (not a tagged machine) may.
//
//   GET  /api/tasks                  the tasks, newest first
//   GET  /api/tasks/<id>             one, with its steps
//   GET  /api/tasks/<id>/screenshot  its last screenshot (PNG)
//   GET  /api/tasks/<id>/watch       {url}: its live desktop, while it runs
//   GET  /api/events                 a stream: "tasks" (the list) first, then "task" events as they happen
//   POST /api/tasks                  {goal, display?}: start one
//   POST /api/tasks/<id>/tell        {message}: tell a running task, or resume a kept one
//   POST /api/tasks/<id>/stop
//   POST /api/tasks/<id>/move        carry a local task on in the cloud
//   POST /api/devices                {token, sandbox}: this phone's push notifications
//   GET  /api/boxes                  the open boxes
//   POST /api/boxes                  {key, repo?, base?, setup?}: a box to ssh into, with its ssh address and Preview
//   DELETE /api/boxes/<id>           close it (kept, to open again); ?discard=1 deletes it for good
//   POST /api/boxes/<id>/open        {key}: open a closed one again
export interface Actions {
  start(goal: string, display?: "mobile" | "desktop"): Promise<number>;
  tell(id: number, message: string): string;
  stop(id: number): boolean;
  move(id: number): string;
  // The live desktop's link for a running task's VM.
  watch(id: number): Promise<string | undefined>;
}

const PORT = Number(process.env.API_PORT ?? 7700);

type Boxes = Pick<ReturnType<typeof boxes>, "open" | "close" | "reopen" | "list" | "discard">;

export function startApi(board: ReturnType<typeof taskBoard>, actions: Actions, push?: ReturnType<typeof pusher>, port = PORT, box?: Boxes) {
  const owner = process.env.API_OWNER;
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let body = "";
      req.on("data", (d) => ((body += d), body.length > 100_000 && req.destroy()));
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("the body isn't JSON"));
        }
      });
    });
  // What goes over the wire: no screenshots inline (they have their own URL).
  const wire = ({ screenshot, ...e }: TaskEvent) => ({ ...e, screenshot: Boolean(screenshot) });

  const server = createServer(async (req, res) => {
    const login = req.headers["tailscale-user-login"];
    if (!login || (owner && login !== owner)) return json(res, 403, { error: "not the owner" });
    const url = new URL(req.url ?? "/", "http://api");
    const [, , what, n, action] = url.pathname.split("/");
    const id = Number(n);
    try {
      if (req.method === "GET" && what === "tasks" && !n) return json(res, 200, { tasks: board.list().map(({ steps, ...t }) => ({ ...t, last: steps.at(-1) })) });
      if (req.method === "GET" && what === "tasks" && !action) {
        const task = board.get(id) ?? board.list().find((t) => t.id === id);
        return task ? json(res, 200, task) : json(res, 404, { error: `no task #${id}` });
      }
      if (req.method === "GET" && what === "tasks" && action === "screenshot") {
        const png = board.screenshot(id);
        return png ? res.writeHead(200, { "Content-Type": "image/png" }).end(png) : json(res, 404, { error: "no screenshot" });
      }
      if (req.method === "GET" && what === "tasks" && action === "watch") return json(res, 200, { url: (await actions.watch(id)) ?? null });
      if (req.method === "GET" && what === "events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`event: tasks\ndata: ${JSON.stringify(board.list().map(({ steps, ...t }) => ({ ...t, last: steps.at(-1) })))}\n\n`);
        const on = (e: TaskEvent) => res.write(`event: task\ndata: ${JSON.stringify(wire(e))}\n\n`);
        // A comment now and then keeps proxies and the phone's connection from idling out.
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        taskEvents.on("event", on);
        req.on("close", () => (clearInterval(ping), taskEvents.off("event", on)));
        return;
      }
      if (req.method === "POST" && what === "tasks" && !n) {
        const { goal, display } = await read(req);
        if (typeof goal !== "string" || !goal.trim()) return json(res, 400, { error: "a goal, please" });
        return json(res, 200, { id: await actions.start(goal, display === "mobile" || display === "desktop" ? display : undefined) });
      }
      if (req.method === "POST" && what === "tasks" && action === "tell") {
        const { message } = await read(req);
        if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "a message, please" });
        return json(res, 200, { result: actions.tell(id, message) });
      }
      if (req.method === "POST" && what === "tasks" && action === "stop") return json(res, 200, { stopped: actions.stop(id) });
      if (req.method === "POST" && what === "tasks" && action === "move") return json(res, 200, { result: actions.move(id) });
      if (what === "boxes") {
        if (!box) return json(res, 404, { error: "no boxes on this machine" });
        if (req.method === "GET" && !n) return json(res, 200, { boxes: box.list() });
        if (req.method === "POST" && !n) {
          const { repo, base, key, setup } = await read(req);
          if (typeof key !== "string") return json(res, 400, { error: "an ssh public key, please" });
          const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
          // A box whose asker went away before it was ready (an app sent to the background, a client that gave up) is
          // closed, so it's kept to open again rather than left open with no one on it.
          let gone = false;
          res.on("close", () => (gone = !res.writableEnded));
          const opened = await box.open({ repo: str(repo), base: str(base), key, setup: str(setup) });
          if (gone) return void (await box.close(opened.id));
          return json(res, 200, opened);
        }
        if (req.method === "DELETE" && n && !action) {
          if (url.searchParams.get("discard")) return json(res, 200, { discarded: await box.discard(id) });
          return json(res, 200, { closed: await box.close(id) });
        }
        if (req.method === "POST" && action === "open") {
          const { key } = await read(req);
          if (typeof key !== "string") return json(res, 400, { error: "an ssh public key, please" });
          const opened = await box.reopen(id, key);
          return opened ? json(res, 200, opened) : json(res, 404, { error: `no box #${id} kept` });
        }
      }
      if (req.method === "POST" && what === "devices") {
        const { token, sandbox } = await read(req);
        push?.register(String(token), Boolean(sandbox));
        return json(res, 200, { push: Boolean(push?.configured) });
      }
      json(res, 404, { error: "not here" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });
  return new Promise<ReturnType<typeof createServer>>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
