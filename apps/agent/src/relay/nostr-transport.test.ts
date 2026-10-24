import { KIND_REGISTRY, type NostrEvent } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { matches, type RegistryFilter } from '../flows/registry-transport.js';
import { NostrTransport } from './nostr-transport.js';

// The Nostr transport against in-memory relays that speak NIP-01 (EVENT/OK, REQ/EVENT/EOSE,
// CLOSE) and can be stopped and started again, as `docker stop nostr-2` does in e2e:demo:v2.

const TAG = 'e'.repeat(64);
const ev = (n: number, tag = TAG): NostrEvent => ({
  id: n.toString(16).padStart(64, '0'),
  pubkey: 'a'.repeat(64),
  created_at: 1_760_000_000 + n,
  kind: KIND_REGISTRY,
  tags: [['T', tag]],
  content: `c${n}`,
  sig: 'b'.repeat(128),
});

type Client = {
  onopen: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
};

/** One relay: a store and the sockets connected to it. */
class FakeRelay {
  readonly events = new Map<string, NostrEvent>();
  up = true;
  readonly clients = new Set<{ c: Client; subs: Map<string, RegistryFilter> }>();

  connect(c: Client): void {
    if (!this.up) {
      queueMicrotask(() => c.onclose?.({}));
      return;
    }
    const conn = { c, subs: new Map<string, RegistryFilter>() };
    this.clients.add(conn);
    c.send = (data) => this.onMessage(conn, JSON.parse(data) as unknown[]);
    c.close = () => this.drop(conn);
    queueMicrotask(() => c.onopen?.({}));
  }

  private reply(conn: { c: Client }, msg: unknown[]): void {
    queueMicrotask(() => conn.c.onmessage?.({ data: JSON.stringify(msg) }));
  }

  private onMessage(conn: { c: Client; subs: Map<string, RegistryFilter> }, m: unknown[]): void {
    const [type, a, b] = m;
    if (type === 'EVENT') {
      const e = a as NostrEvent;
      const dup = this.events.has(e.id);
      this.events.set(e.id, e);
      this.reply(conn, ['OK', e.id, true, dup ? 'duplicate: have it' : '']);
      if (!dup)
        for (const other of this.clients)
          for (const [id, f] of other.subs) if (matches(f, e)) this.reply(other, ['EVENT', id, e]);
    } else if (type === 'REQ') {
      const raw = b as { '#T'?: string[]; authors?: string[]; ids?: string[] };
      const f: RegistryFilter = {
        ...(raw['#T'] && { tripTag: raw['#T'][0] }),
        ...(raw.authors && { authors: raw.authors }),
        ...(raw.ids && { ids: raw.ids }),
      };
      conn.subs.set(a as string, f);
      for (const e of this.events.values()) if (matches(f, e)) this.reply(conn, ['EVENT', a, e]);
      this.reply(conn, ['EOSE', a]);
    } else if (type === 'CLOSE') conn.subs.delete(a as string);
  }

  private drop(conn: { c: Client; subs: Map<string, RegistryFilter> }): void {
    if (!this.clients.delete(conn)) return;
    conn.c.send = () => undefined; // a closed socket delivers nothing
    queueMicrotask(() => conn.c.onclose?.({}));
  }

  stop(): void {
    this.up = false;
    for (const conn of [...this.clients]) this.drop(conn);
  }

  start(): void {
    this.up = true;
  }
}

function net(n = 3) {
  const relays = new Map<string, FakeRelay>();
  for (let i = 1; i <= n; i++) relays.set(`ws://relay-${i}`, new FakeRelay());
  const socket = (url: string) => {
    const c = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      readyState: 1,
    } as unknown as Client;
    c.send = () => undefined;
    c.close = () => undefined;
    relays.get(url)?.connect(c);
    return c;
  };
  const transport = () =>
    new NostrTransport({
      urls: [...relays.keys()],
      socket: socket as never,
      reconnectMs: 5,
      queryTimeoutMs: 200,
      publishTimeoutMs: 200,
    });
  return { relays, transport, relay: (i: number) => relays.get(`ws://relay-${i}`) as FakeRelay };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('NostrTransport (NIP-01)', () => {
  it('publishes to every relay and reads from all of them, without duplicates', async () => {
    const n = net();
    const a = n.transport();
    await tick();
    await a.publish(ev(1));
    await tick();
    for (const r of n.relays.values()) expect(r.events.has(ev(1).id)).toBe(true);
    n.relay(2).events.set(ev(2).id, ev(2)); // only one relay has it
    const got = await a.query({ tripTag: TAG });
    expect(got.map((e) => e.id).sort()).toEqual([ev(1).id, ev(2).id]);
    expect(await a.fetchMissing([ev(2).id])).toEqual([ev(2)]);
    a.close();
  });

  it('a subscription gets stored events, then live ones, once each', async () => {
    const n = net();
    const a = n.transport();
    const b = n.transport();
    await tick();
    await a.publish(ev(1));
    const seen: string[] = [];
    b.subscribe({ tripTag: TAG }, (e) => seen.push(e.id));
    await tick();
    await a.publish(ev(2));
    await a.publish(ev(3, 'f'.repeat(64))); // another trip: not delivered
    await tick();
    expect(seen).toEqual([ev(1).id, ev(2).id]);
    a.close();
    b.close();
  });

  it('a relay down: the others carry on; back up, it gets every event it missed', async () => {
    const n = net();
    const a = n.transport();
    const b = n.transport();
    const seen: string[] = [];
    b.subscribe({ tripTag: TAG }, (e) => seen.push(e.id));
    a.subscribe({ tripTag: TAG }, () => undefined);
    await tick();
    n.relay(2).stop();
    await a.publish(ev(1));
    await a.publish(ev(2));
    await tick();
    expect(seen).toEqual([ev(1).id, ev(2).id]);
    expect(n.relay(2).events.size).toBe(0);
    expect(a.status().map((s) => s.connected)).toEqual([true, false, true]);
    n.relay(2).start();
    await tick(80);
    expect([...n.relay(2).events.keys()].sort()).toEqual([ev(1).id, ev(2).id]);
    expect(a.status().every((s) => s.connected)).toBe(true);
    a.close();
    b.close();
  });

  it('every relay down: publish does not throw; the event goes out when one is back', async () => {
    const n = net(1);
    const a = n.transport();
    a.subscribe({ tripTag: TAG }, () => undefined);
    await tick();
    n.relay(1).stop();
    await expect(a.publish(ev(1))).resolves.toBeUndefined();
    n.relay(1).start();
    await tick(80);
    expect(n.relay(1).events.has(ev(1).id)).toBe(true);
    a.close();
  });
});
