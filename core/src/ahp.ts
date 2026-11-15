import {
  type ActionEnvelope,
  changesetReducer,
  chatReducer,
  PROTOCOL_VERSION,
  rootReducer,
  sessionReducer,
  type Snapshot,
  type StateAction,
  terminalReducer,
  type URI,
} from "@microsoft/agent-host-protocol";
import type { WebSocket } from "ws";

// An Agent Host Protocol host (microsoft.github.io/agent-host-protocol): each channel's state, changed only by the
// protocol's own reducers; each committed action numbered (serverSeq), sent to the channel's subscribers, and kept a
// while, so a client that reconnects gets what it missed instead of starting over. What the channels mean is the
// caller's: `handlers` answer the commands and act on clients' actions. Methods biscotti adds are named x-biscotti/….
// The protocol's enums are TypeScript const enums, which this repo can't import: their values are written out.

export const ROOT = "ahp-root://";
const REPLAY = 5000;

type State = Record<string, unknown>;
type Reducer = (state: never, action: never) => unknown;
const reducerOf = (uri: URI): Reducer | undefined =>
  (uri === ROOT
    ? rootReducer
    : uri.startsWith("ahp-session:")
      ? sessionReducer
      : uri.startsWith("ahp-chat:")
        ? chatReducer
        : uri.startsWith("ahp-terminal:")
          ? terminalReducer
          : uri.startsWith("ahp-changeset:")
            ? changesetReducer
            : undefined) as Reducer | undefined;

export interface AhpHandlers {
  // The session catalogue (listSessions), newest first.
  listSessions(): unknown[] | Promise<unknown[]>;
  // A channel not in memory yet (a session from storage, its chat), created with `host.create`; false if unknown.
  hydrate?(uri: URI): Promise<boolean>;
  createSession?(params: Record<string, unknown>, clientId: string): Promise<void>;
  disposeSession?(uri: URI): Promise<void>;
  createChat?(params: Record<string, unknown>, clientId: string): Promise<void>;
  disposeChat?(uri: URI): Promise<void>;
  // A client's action on a channel: why it's refused, or undefined to commit it; then `acted` carries it out.
  validate?(channel: URI, action: StateAction, clientId: string): string | undefined;
  acted?(channel: URI, action: StateAction, clientId: string): void;
  // Methods of its own, by name.
  methods?: Record<string, (params: Record<string, unknown>, clientId: string) => Promise<unknown>>;
}

interface Client {
  socket: WebSocket;
  id?: string;
  subscriptions: Set<URI>;
}

export class AhpHost {
  readonly #states = new Map<URI, State>();
  // Numbered from the clock, so numbers keep rising across restarts and a client never mistakes a new host's actions
  // for ones it saw.
  #seq = Date.now();
  readonly #log: ActionEnvelope[] = [];
  readonly #clients = new Set<Client>();
  readonly #known = new Set<string>();
  readonly #handlers: AhpHandlers;
  readonly #info: { name: string; version: string };

  constructor(handlers: AhpHandlers, info: { name: string; version: string }) {
    this.#handlers = handlers;
    this.#info = info;
  }

  get<T = State>(uri: URI): T | undefined {
    return this.#states.get(uri) as T | undefined;
  }
  has(uri: URI) {
    return this.#states.has(uri);
  }
  create(uri: URI, state: object) {
    this.#states.set(uri, state as State);
  }
  delete(uri: URI) {
    this.#states.delete(uri);
    for (const c of this.#clients) c.subscriptions.delete(uri);
  }

  // An action of the host's own: applied, numbered, kept and sent.
  dispatch(channel: URI, action: StateAction, origin?: ActionEnvelope["origin"]) {
    const state = this.#states.get(channel);
    const reduce = reducerOf(channel);
    if (!state || !reduce) return;
    this.#states.set(channel, reduce(state as never, action as never) as State);
    const envelope: ActionEnvelope = { channel, action, serverSeq: ++this.#seq, origin };
    this.#log.push(envelope);
    if (this.#log.length > REPLAY) this.#log.splice(0, this.#log.length - REPLAY);
    this.#send(channel, { jsonrpc: "2.0", method: "action", params: envelope });
  }

  // A notification (root/sessionAdded, …) to every client subscribed to `channel`.
  notify(channel: URI, method: string, params: object) {
    this.#send(channel, { jsonrpc: "2.0", method, params: { channel, ...params } });
  }

  #send(channel: URI, message: object) {
    const text = JSON.stringify(message);
    for (const c of this.#clients) if (c.subscriptions.has(channel) && c.socket.readyState === 1) c.socket.send(text);
  }
  #snapshot(uri: URI): Snapshot | undefined {
    const state = this.#states.get(uri);
    return state ? ({ resource: uri, state, fromSeq: this.#seq } as Snapshot) : undefined;
  }
  async #channel(uri: URI) {
    if (!this.#states.has(uri)) await this.#handlers.hydrate?.(uri).catch(() => false);
    return this.#states.has(uri);
  }

  accept(socket: WebSocket) {
    const client: Client = { socket, subscriptions: new Set() };
    this.#clients.add(client);
    socket.on("close", () => this.#clients.delete(client));
    socket.on("message", (data) => {
      let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.method === undefined) return;
      const reply = (body: object) => socket.readyState === 1 && socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
      this.#handle(client, message.method, message.params ?? {}).then(
        (result) => message.id !== undefined && reply({ result: result ?? null }),
        (err: Error & { code?: number }) => message.id !== undefined && reply({ error: { code: err.code ?? -32603, message: err.message } }),
      );
    });
  }

  async #handle(client: Client, method: string, params: Record<string, unknown>): Promise<unknown> {
    const clientId = client.id ?? "";
    switch (method) {
      case "initialize": {
        client.id = String(params.clientId);
        this.#known.add(client.id);
        const snapshots: Snapshot[] = [];
        for (const uri of (params.initialSubscriptions as URI[] | undefined) ?? []) {
          if (!(await this.#channel(uri))) continue;
          client.subscriptions.add(uri);
          snapshots.push(this.#snapshot(uri)!);
        }
        return { protocolVersion: PROTOCOL_VERSION, serverSeq: this.#seq, serverInfo: this.#info, snapshots };
      }
      case "reconnect": {
        client.id = String(params.clientId);
        const known = this.#known.has(client.id);
        this.#known.add(client.id);
        client.subscriptions.clear();
        const missing: URI[] = [];
        for (const uri of (params.subscriptions as URI[] | undefined) ?? []) {
          if (await this.#channel(uri)) client.subscriptions.add(uri);
          else missing.push(uri);
        }
        const last = Number(params.lastSeenServerSeq ?? 0);
        const oldest = this.#log[0]?.serverSeq ?? this.#seq + 1;
        if (known && last >= oldest - 1 && last <= this.#seq)
          return { type: "replay", actions: this.#log.filter((e) => e.serverSeq > last && client.subscriptions.has(e.channel)), missing };
        return { type: "snapshot", snapshots: [...client.subscriptions].map((uri) => this.#snapshot(uri)!) };
      }
      case "ping":
        return null;
      case "subscribe": {
        const uri = String(params.channel);
        if (!(await this.#channel(uri))) throw Object.assign(new Error(`no channel ${uri}`), { code: -32004 });
        client.subscriptions.add(uri);
        return { snapshot: this.#snapshot(uri) };
      }
      case "unsubscribe":
        client.subscriptions.delete(String(params.channel));
        return null;
      case "listSessions":
        return { items: await this.#handlers.listSessions() };
      case "createSession":
        return void (await this.#handlers.createSession?.(params, clientId));
      case "disposeSession":
        return void (await this.#handlers.disposeSession?.(String(params.channel)));
      case "createChat":
        return void (await this.#handlers.createChat?.(params, clientId));
      case "disposeChat":
        return void (await this.#handlers.disposeChat?.(String(params.channel)));
      case "dispatchAction": {
        const channel = String(params.channel);
        const action = params.action as StateAction;
        const origin = { clientId, clientSeq: Number(params.clientSeq) };
        await this.#channel(channel);
        const refused = this.#states.has(channel) ? this.#handlers.validate?.(channel, action, clientId) : "no such channel";
        if (refused) {
          const envelope: ActionEnvelope = { channel, action, serverSeq: this.#seq, origin, rejectionReason: refused };
          client.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "action", params: envelope }));
          return null;
        }
        this.dispatch(channel, action, origin);
        this.#handlers.acted?.(channel, action, clientId);
        return null;
      }
      default: {
        const own = this.#handlers.methods?.[method];
        if (!own) throw Object.assign(new Error(`no method ${method}`), { code: -32601 });
        return own(params, clientId);
      }
    }
  }
}
