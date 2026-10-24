// OWNED BY STREAM C (step 4): the registry v2 over Nostr relays (NIP-01), behind the Transport
// interface of the flows (registry-transport.ts). One instance per phone: it publishes every
// event to every relay and reads from every relay. It trusts none of them: the registry
// verifies each event, and a relay can only withhold. A relay that comes back gets, after its
// stored events (EOSE), every event of this phone's subscriptions it did not return: what it
// lost while it was down. Kind 7345 only; the ephemerals (27345) come with step 7.
import { KIND_REGISTRY, type NostrEvent } from '@kitty/shared';
import {
  matches,
  type RegistryFilter,
  type RegistryTransport,
} from '../flows/registry-transport.js';

type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export interface NostrTransportOptions {
  /** ws:// URLs of the relays (KITTY_NOSTR_RELAYS). */
  urls: readonly string[];
  /** Tests: a fake WebSocket. Default: the global one of Node 22. */
  socket?: (url: string) => Socket;
  /** After a close, reconnect after this (default 1 s). */
  reconnectMs?: number;
  /** A REQ that gets no EOSE in this time counts what it got (default 3 s). */
  queryTimeoutMs?: number;
  /** publish waits at most this for the first OK (default 3 s). */
  publishTimeoutMs?: number;
  log?: { warn(msg: string): void };
}

/** NIP-01 filter of a registry filter: always kind 7345. */
function nostrFilter(f: RegistryFilter): Record<string, unknown> {
  return {
    kinds: [KIND_REGISTRY],
    ...(f.tripTag !== undefined && { '#T': [f.tripTag] }),
    ...(f.authors !== undefined && { authors: [...f.authors] }),
    ...(f.ids !== undefined && { ids: [...f.ids] }),
  };
}

interface Live {
  filter: RegistryFilter;
  on: (e: NostrEvent) => void;
  seen: Set<string>;
}

let counter = 0;
const subId = (prefix: string) => `${prefix}${(++counter).toString(36)}`;

class Relay {
  private socket: Socket | null = null;
  private open = false;
  private closed = false;
  /** Ids this relay has: it returned them, or accepted them (OK true). */
  readonly has = new Set<string>();
  private readonly oks = new Map<string, ((ok: boolean) => void)[]>();
  private readonly reqs = new Map<
    string,
    { onEvent: (e: NostrEvent) => void; onEose: () => void }
  >();
  /** The REQ id of each live subscription on this connection. */
  private readonly liveIds = new Map<Live, string>();

  constructor(
    readonly url: string,
    private readonly t: NostrTransport,
  ) {
    this.connect();
  }

  get connected(): boolean {
    return this.open;
  }

  private connect(): void {
    if (this.closed) return;
    let s: Socket;
    try {
      s = this.t.newSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.socket = s;
    s.onopen = () => {
      this.open = true;
      for (const live of this.t.lives) this.req(live);
    };
    s.onmessage = (m) => this.onMessage(m.data);
    // Node 22's WebSocket reports a failed connection with `error` only, never `close`: both
    // mean the connection is lost, handled once per socket.
    s.onerror = () => this.lost(s);
    s.onclose = () => this.lost(s);
  }

  private lost(s: Socket): void {
    if (this.socket !== s) return;
    this.open = false;
    this.socket = null;
    try {
      s.close();
    } catch {
      // already closed
    }
    this.liveIds.clear();
    for (const list of this.oks.values()) for (const r of list) r(false);
    this.oks.clear();
    for (const r of this.reqs.values()) r.onEose();
    this.reqs.clear();
    this.retry();
  }

  private retry(): void {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.t.reconnectMs).unref?.();
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  private send(msg: unknown[]): boolean {
    if (!this.open || this.socket === null) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** EVENT, resolving with the relay's OK (false if down or no answer in time). */
  publish(e: NostrEvent, timeoutMs: number): Promise<boolean> {
    if (this.has.has(e.id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      if (!this.send(['EVENT', e])) return resolve(false);
      const list = this.oks.get(e.id) ?? [];
      list.push(resolve);
      this.oks.set(e.id, list);
      setTimeout(() => resolve(false), timeoutMs).unref?.();
    });
  }

  /** A one-shot REQ: the stored events, until EOSE or the timeout. */
  query(f: RegistryFilter, timeoutMs: number): Promise<NostrEvent[]> {
    return new Promise((resolve) => {
      const id = subId('q');
      const got: NostrEvent[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.reqs.delete(id);
        this.send(['CLOSE', id]);
        resolve(got);
      };
      this.reqs.set(id, { onEvent: (e) => got.push(e), onEose: finish });
      if (!this.send(['REQ', id, nostrFilter(f)])) return finish();
      setTimeout(finish, timeoutMs).unref?.();
    });
  }

  /** Opens a live subscription on this connection (again after each reconnection). */
  req(live: Live): void {
    if (!this.open) return;
    const id = subId('s');
    this.liveIds.set(live, id);
    this.reqs.set(id, {
      onEvent: (e) => this.t.deliver(live, e),
      // after its stored events: what this relay lacks of the subscription, it gets again
      onEose: () => this.t.catchUp(this, live),
    });
    this.send(['REQ', id, nostrFilter(live.filter)]);
  }

  unreq(live: Live): void {
    const id = this.liveIds.get(live);
    if (id === undefined) return;
    this.liveIds.delete(live);
    this.reqs.delete(id);
    this.send(['CLOSE', id]);
  }

  private onMessage(data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, a, b] = msg as [unknown, unknown, unknown];
    if (type === 'EVENT' && typeof a === 'string') {
      const e = b as NostrEvent;
      if (typeof e?.id !== 'string') return;
      this.has.add(e.id);
      this.reqs.get(a)?.onEvent(e);
    } else if (type === 'EOSE' && typeof a === 'string') {
      const r = this.reqs.get(a);
      // a live subscription stays open after EOSE; a query finishes
      if (r !== undefined) r.onEose();
    } else if (type === 'OK' && typeof a === 'string') {
      // NIP-01: true, or false with a reason; a duplicate is accepted ("duplicate:")
      const ok = b === true || String(msg[3] ?? '').startsWith('duplicate');
      if (ok) this.has.add(a);
      for (const r of this.oks.get(a) ?? []) r(ok);
      this.oks.delete(a);
    } else if (type === 'CLOSED' && typeof a === 'string') {
      this.reqs.get(a)?.onEose();
      this.reqs.delete(a);
    }
  }
}

export class NostrTransport implements RegistryTransport {
  readonly reconnectMs: number;
  private readonly queryTimeoutMs: number;
  private readonly publishTimeoutMs: number;
  /** Every event this phone published or received: what a relay that lost them gets again. */
  private readonly known = new Map<string, NostrEvent>();
  readonly lives = new Set<Live>();
  private readonly relays: Relay[];
  private readonly socket: (url: string) => Socket;

  constructor(o: NostrTransportOptions) {
    if (o.urls.length === 0) throw new Error('KITTY_NOSTR_RELAYS: at least one relay');
    this.reconnectMs = o.reconnectMs ?? 1_000;
    this.queryTimeoutMs = o.queryTimeoutMs ?? 3_000;
    this.publishTimeoutMs = o.publishTimeoutMs ?? 3_000;
    this.socket = o.socket ?? ((url) => new WebSocket(url) as unknown as Socket);
    this.relays = o.urls.map((url) => new Relay(url, this));
  }

  newSocket(url: string): Socket {
    return this.socket(url);
  }

  /** Which relays this phone is connected to now (UI, tests). */
  status(): { url: string; connected: boolean }[] {
    return this.relays.map((r) => ({ url: r.url, connected: r.connected }));
  }

  async publish(e: NostrEvent): Promise<void> {
    this.known.set(e.id, e);
    // Resolves at the first relay that accepts it; the others keep going in the background,
    // and a relay that is down gets it on catch-up.
    await new Promise<void>((resolve) => {
      let pending = this.relays.length;
      for (const r of this.relays)
        void r.publish(e, this.publishTimeoutMs).then((ok) => {
          pending -= 1;
          if (ok || pending === 0) resolve();
        });
    });
  }

  async query(f: RegistryFilter): Promise<readonly NostrEvent[]> {
    const all = await Promise.all(this.relays.map((r) => r.query(f, this.queryTimeoutMs)));
    const out = new Map<string, NostrEvent>();
    for (const list of all) for (const e of list) if (matches(f, e)) out.set(e.id, e);
    for (const e of out.values()) this.known.set(e.id, e);
    return [...out.values()];
  }

  subscribe(f: RegistryFilter, on: (e: NostrEvent) => void): () => void {
    const live: Live = { filter: f, on, seen: new Set() };
    this.lives.add(live);
    for (const r of this.relays) r.req(live);
    return () => {
      this.lives.delete(live);
      for (const r of this.relays) r.unreq(live);
    };
  }

  fetchMissing(ids: readonly string[]): Promise<readonly NostrEvent[]> {
    return ids.length === 0 ? Promise.resolve([]) : this.query({ ids });
  }

  close(): void {
    for (const r of this.relays) r.close();
  }

  /** An event of a live subscription, from any relay: once per subscription. */
  deliver(live: Live, e: NostrEvent): void {
    if (!matches(live.filter, e) || live.seen.has(e.id)) return;
    live.seen.add(e.id);
    this.known.set(e.id, e);
    live.on(e);
  }

  /** After a relay's EOSE on a subscription: everything it lacks of it, published to it. */
  catchUp(relay: Relay, live: Live): void {
    for (const e of this.known.values())
      if (matches(live.filter, e) && !relay.has.has(e.id))
        void relay.publish(e, this.publishTimeoutMs);
  }
}
