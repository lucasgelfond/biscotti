import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

// The task VMs' API, for the plugins that add machines for them (firecracker, external-vm-node) or use them (ssh-vms,
// github's coding tasks, jev-quick-browse, vm-check, push): `vms(ctx)` (index.ts).

// A task VM, in a slot of a host.
export interface Vm {
  slot: number;
  stop(): Promise<void>;
  // Pauses it and saves it (memory and disk) as `id`, freeing the slot; the host's `resume` brings it back. One that
  // can't be saved but carries on as it was rejects with `running` set on the error.
  suspend?(id: number): Promise<void>;
}

// The vms service's answer when a VM couldn't be saved but carries on (409), as Vm.suspend's error says it.
export const stillRunning = (err: Error & { status?: number }) => Promise.reject(Object.assign(err, { running: err.status === 409 }));

// Where task VMs run: this machine's vms service, or a plugin's machines (Vms.addHost): Firecracker here or on EC2,
// a Mac's. Every one is asked the same things; only `restore` is required. Slot numbers are the host's own; this
// machine's are 1 to VM_SLOTS.
export interface Host {
  // What kind of machine, for asking for one by kind ("local", "cloud", "mac", …): "cloud" for an overflow host,
  // "local" otherwise, by default.
  label?: string;
  slots: number[];
  restore(slot: number): Promise<Vm>;
  resume?(slot: number, id: number): Promise<Vm>;
  discard?(slot: number, id: number): Promise<void>;
  // Sets the slot's VM up: a key authorized for ssh (the gate's, for pi-env, or the owner's), a repo checked out (a git
  // bundle), a setup command run; each optional. Answers with its ssh host key. By default the VM image's own setup
  // (prepareVm, core/vm/task/biscotti-task).
  prepare?(slot: number, setup: Setup): Promise<string | undefined>;
  // Where the gate reaches port `port` of the slot's VM, and where that VM reaches the gate (a listener that takes only
  // `peer()`).
  endpoint(slot: number, port: number): { host: string; port: number };
  gate(slot: number): { host: string; port: number; peer(): string | undefined };
  // Where the owner reaches the slot's VM's sshd, when it isn't the endpoint for port 22 (a port on the tailnet).
  ssh?(slot: number): { host: string; port: number };
  // The slot's live desktop.
  watch?(slot: number): string | Promise<string>;
  // The slot's VM's web server (its port 8000), for a preview of what a task made.
  site?(slot: number): string | Promise<string>;
  // Whether someone's on the slot's VM (an ssh or desktop session).
  active?(slot: number): boolean | Promise<boolean>;
  // A host that costs money to run: used only once every other host's slots are taken, and never kept warm.
  overflow?: boolean;
  // pi-env's daemon in the slot's VM with `args`, piped to `socket` once it's starting (after answering the upgrade,
  // "HTTP/1.1 101"); over ssh to its port 22 otherwise (vm-env.ts).
  env?(slot: number, args: string[], socket: Duplex): Promise<void>;
}

// What happens to tasks and VMs, as events naming the task (or VM) number: for the board (the owner's apps) and
// plugins (push notifications).
export interface TaskEvent {
  id: number;
  // "deleted": gone for good, its row too (the owner deleted its chat).
  type: "queued" | "started" | "report" | "kept" | "done" | "failed" | "resumed" | "deleted";
  at: number;
  goal?: string;
  slot?: number;
  where?: string;
  text?: string;
  // Fields a plugin adds for its own VMs (ssh-vms).
  [field: string]: unknown;
}
export const taskEvents = new EventEmitter<{ event: [TaskEvent] }>();
taskEvents.setMaxListeners(100);
export const emit = (event: Omit<TaskEvent, "at">) => taskEvents.emit("event", { ...event, at: Date.now() } as TaskEvent);

export interface Running {
  id: number;
  goal: string;
  slot?: number;
  started: number;
}
// A finished or stopped task's VM, or a closed VM of a plugin's, kept (suspended) for later.
export interface Kept {
  id: number;
  goal: string;
  slot: number;
  at: number;
  // The pull request its work became (vms.note).
  pr?: string;
}

// A VM still around once its task is done: open (running: kept open, or a plugin's, like an ssh VM) or asleep (kept on
// disk), with when it was last used (an ssh or desktop session on it, or its agent working) and its pull request.
export interface Alive {
  id: number;
  goal: string;
  asleep: boolean;
  used: number;
  pr?: string;
}
// One of them in a line, for the main agent.
const ago = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86400_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86400_000)} days`);
export const aliveLine = (v: Alive, now = Date.now()) =>
  `#${v.id} (${v.asleep ? "asleep" : "open"}, last used ${ago(now - v.used)} ago${now - v.used > 86400_000 ? ", idle over a day" : ""}${v.pr ? `, pull request ${v.pr}` : ""}): ${v.goal.replace(/\s+/g, " ").slice(0, 160)}`;

// `parent`: the main session that started it, where its report goes. A task's VM is deleted once it's done, unless
// `keep` (or vms.keep) keeps it open. `after` makes something of each run's result before it's reported, the first
// run's and each follow-up's, while its VM is still there (a coding task's commits pushed, its preview's address).
export type RunOptions = TaskOptions & {
  id?: number;
  fits?: (slot: number) => boolean;
  parent?: string;
  keep?: boolean;
  after?: (result: TaskResult) => Promise<TaskResult>;
};

export interface Vms {
  // A task whose report comes back to the caller. `fits` limits the slots it may take; `id` is one `reserve` gave.
  run(goal: string, opts?: RunOptions): Promise<TaskResult>;
  // A number for a task or VM to come (`run`'s `id`), so a client can name it before it starts.
  reserve(): number;
  // A task like the main agent's task tool starts: its report goes to the main agent. Its number.
  start(goal: string, opts?: RunOptions): number;
  // The owner's message for a task: given to it running, held for it queued, or a kept one resumed with it.
  tell(id: number, message: string): "told" | "queued" | "resumed" | "none";
  stop(id: number): boolean;
  running(): Running[];
  kept(): Kept[];
  // A VM of the caller's own (not a task), numbered like tasks, until it gives it back: kept for later (`give`), or
  // thrown away (`drop`); `remove` deletes it for good, kept or not. `reclaim` brings a kept one back.
  // One with `sleep` may be put to sleep (`sleep.sleep(id)`, which gives it back) when every slot is held and another
  // needs one: the one whose `sleep.used(id)` is oldest.
  // `where`: a host's label ("local", "cloud", …), any by default.
  hold(goal: string, opts?: { model?: string; where?: string; fits?: (slot: number) => boolean; sleep?: Sleep }): Promise<{ id: number; vm: Vm }>;
  give(id: number): Promise<void>;
  drop(id: number): Promise<void>;
  reclaim(id: number, opts?: { model?: string; sleep?: Sleep }): Promise<Vm | undefined>;
  // A running task's or held VM's VM set up (Host.prepare), and the label of the host it's on.
  prepare(id: number, setup: Setup): Promise<string | undefined>;
  where(id: number): string | undefined;
  // Where the owner reaches its sshd.
  ssh(id: number): { host: string; port: number };
  // The labels of the hosts there are.
  labels(): string[];
  // The live desktop of a running task's or held VM's, and its web server (a preview).
  watch(id: number): Promise<string | undefined>;
  site(id: number): Promise<string | undefined>;
  // A task's VM kept open once it's done (it's deleted otherwise), or an asleep one woken and kept open; false when
  // there's no such task or VM.
  keep(id: number): Promise<boolean>;
  // The VMs still around (open or asleep), and deleting one for good (a running task's once it's done).
  alive(): Alive[];
  remove(id: number): Promise<boolean>;
  // What a task's or VM's work became.
  note(id: number, note: { pr?: string }): void;
  addHost(host: Host): Promise<void>;
}

// How a held VM goes to sleep for another that needs its slot, and when it was last used (ms since the epoch).
export interface Sleep {
  used(id: number): number;
  sleep(id: number): Promise<void>;
}

export interface TaskOptions {
  repo?: Buffer;
  // More for its agent's instructions (a coding task's).
  instructions?: string;
  // Whether its final screen is checked against the goal before it reports (yes, unless false).
  check?: boolean;
  // A command its VM runs once each run is done, and the file it leaves to come back as the result's `collected` (a
  // coding task's commits, as a bundle); none when the command prints "none".
  collect?: { command: string; file: string };
  // A plugin's own agent instead of pi: file name -> source, run in the VM as `node main.ts` with the goal on stdin
  // (what it prints is the report). It reaches the gate at http://gate like pi does.
  runner?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
  // The desktop's shape: "mobile" (portrait, phone-sized) when the owner will watch from a phone, "desktop" otherwise.
  display?: "mobile" | "desktop";
}

// What the gate asks the main agent for (agent.ts): a task's first run, or a follow-up of one that already ran.
export interface TaskRun {
  id: number;
  // Its first run's goal, or the owner's message for a follow-up.
  goal: string;
  followup?: boolean;
  model?: string;
  display?: string;
  runner?: Record<string, string>;
  instructions?: string;
  check?: boolean;
  collect?: { command: string; file: string };
  // The owner's messages that came while it waited for a VM.
  told?: string[];
}

export interface TaskResult {
  report: string;
  screenshot?: Buffer;
  collected?: Buffer;
}

// Where the gate reaches port `port` of the task VM in `slot`: its host's endpoint, or this machine's slot link.
export const endpoints = new Map<number, (port: number) => { host: string; port: number }>();
export function vmEndpoint(slot: number, port: number) {
  const at = endpoints.get(slot);
  if (!at) throw new Error(`no machine has slot ${slot}`);
  return at(port);
}

export interface Setup {
  key?: string;
  repo?: Buffer;
  setup?: string;
}

// How long a VM's setup (a checkout, a setup command) may take.
const PREPARE_TIMEOUT_MS = 30 * 60_000;
// The VM image's own setup (core/vm/task/biscotti-task) sets it up: the key authorized, the repo checked out, the setup
// command run. It answers with the VM's host key.
export function prepareVm({ host, port }: { host: string; port: number }, message: Setup) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.end(JSON.stringify({ box: { key: message.key, repo: message.repo?.toString("base64"), setup: message.setup } })));
    const timer = setTimeout(() => socket.destroy(new Error("setting up the VM took too long")), PREPARE_TIMEOUT_MS);
    let done = false;
    createInterface({ input: socket, crlfDelay: Infinity })
      .on("error", () => {})
      .on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== "box") return;
          done = true;
          clearTimeout(timer);
          if (event.ok) resolve(event.hostKey);
          else reject(new Error(event.error ?? "the VM couldn't be set up"));
        } catch {}
      });
    socket.on("error", (err) => (clearTimeout(timer), reject(err)));
    // TODO: an ssh VM on an EC2 node ends here (its setup closes the connection); tasks there set up fine.
    socket.on("close", () => (clearTimeout(timer), done || reject(new Error("the VM closed the connection"))));
  });
}
