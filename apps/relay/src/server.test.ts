import { GENESIS_HASH, StoredEventSchema, type StoredEvent } from '@kitty/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRelay, type RelayOptions } from './server.js';
import { fakeValidate, rateSet, testDeps, tripCreated, wire } from './test/helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const relay = (opts: RelayOptions = {}) => {
  app = buildRelay({ logger: false, validate: fakeValidate, deps: testDeps, ...opts });
  return app;
};

const post = (a: FastifyInstance, body: unknown) =>
  a.inject({ method: 'POST', url: '/events', payload: body as object });

describe('relay HTTP', () => {
  it('answers /health', async () => {
    const res = await relay().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'relay' });
  });

  it('POST /events accepts and chains; GET /events lists since a seq', async () => {
    const a = relay();
    const r1 = await post(a, wire(tripCreated()));
    const r2 = await post(a, wire(rateSet()));
    expect(r1.statusCode).toBe(201);
    const s1 = StoredEventSchema.parse(r1.json());
    const s2 = StoredEventSchema.parse(r2.json());
    expect(s1.prevHash).toBe(GENESIS_HASH);
    expect(s2.prevHash).toBe(s1.hash);

    const all = await a.inject({ method: 'GET', url: '/events' });
    expect(all.json<unknown[]>().map((e) => StoredEventSchema.parse(e).seq)).toEqual([1, 2]);
    const after1 = await a.inject({ method: 'GET', url: '/events?since=1' });
    expect(after1.json<StoredEvent[]>().map((e) => e.seq)).toEqual([2]);
    const bad = await a.inject({ method: 'GET', url: '/events?since=-1' });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects altered events and duplicate nonces with an ApiErrorBody', async () => {
    const a = relay();
    const first = tripCreated();
    await post(a, wire(first));

    const altered = rateSet();
    altered.inner.createdAt = '2026-10-17T12:00:09.000Z';
    const r1 = await post(a, wire(altered));
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toMatchObject({
      error: { code: 'INVALID_EVENT', action: expect.any(String) },
    });

    const replay = rateSet();
    replay.inner.nonce = first.inner.nonce;
    expect((await post(a, wire(replay))).statusCode).toBe(409);

    const malformed = await post(a, { hello: 'world' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const list = await a.inject({ method: 'GET', url: '/events' });
    expect(list.json<unknown[]>()).toHaveLength(1);
  });

  it("validates with the ledger's validateEvent by default", async () => {
    const a = buildRelay({ logger: false, deps: testDeps });
    app = a;
    expect((await post(a, wire(tripCreated()))).statusCode).toBe(201);
    const forged = rateSet();
    forged.sig = 'not-a-signature';
    const r = await post(a, wire(forged));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: { code: 'INVALID_EVENT', message: 'invalid signature' },
    });
  });
});

describe('relay SSE', () => {
  /** Reads SSE frames from a real socket until `count` `stored` events arrived. */
  async function collect(url: string, count: number, onOpen?: () => Promise<void>) {
    const ctrl = new AbortController();
    const res = await fetch(url, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const events: { id: number; seq: number }[] = [];
    let buf = '';
    let opened = false;
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame === ': connected' && !opened) {
          opened = true;
          await onOpen?.();
        }
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (id && data) {
          events.push({ id: Number(id), seq: StoredEventSchema.parse(JSON.parse(data)).seq });
        }
      }
    }
    ctrl.abort();
    return events;
  }

  it('sends the backlog after `since`, then live events', async () => {
    const a = relay();
    await post(a, wire(tripCreated()));
    await post(a, wire(rateSet()));
    const base = await a.listen({ host: '127.0.0.1', port: 0 });

    const events = await collect(`${base}/events/stream?since=1`, 2, async () => {
      await post(a, wire(rateSet()));
    });
    expect(events).toEqual([
      { id: 2, seq: 2 },
      { id: 3, seq: 3 },
    ]);
  });

  it('resumes from Last-Event-ID', async () => {
    const a = relay();
    await post(a, wire(tripCreated()));
    await post(a, wire(rateSet()));
    await post(a, wire(rateSet()));
    const base = await a.listen({ host: '127.0.0.1', port: 0 });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events/stream`, {
      headers: { 'last-event-id': '2' },
      signal: ctrl.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes(': connected')) text += (await reader.read()).value ?? '';
    ctrl.abort();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1])).toEqual(['3']);
  });

  it('closes cleanly with an open stream', async () => {
    const a = relay();
    const base = await a.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${base}/events/stream`);
    expect(res.status).toBe(200);
    await a.close();
    app = undefined;
  });
});

describe('relay backups', () => {
  const pk = 'b'.repeat(64);
  const put = (a: FastifyInstance, body: Buffer, key = pk) =>
    a.inject({
      method: 'PUT',
      url: `/backups/${key}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: body,
    });

  it('stores opaque blobs and returns the latest version', async () => {
    const a = relay();
    expect((await a.inject({ method: 'GET', url: `/backups/${pk}` })).statusCode).toBe(404);
    const v1 = await put(a, Buffer.from([1, 2, 3]));
    const v2 = await put(a, Buffer.from([9, 8, 7, 0, 255]));
    expect(v1.statusCode).toBe(201);
    expect(v2.json<{ version: number }>().version).toBeGreaterThan(
      v1.json<{ version: number }>().version,
    );
    const got = await a.inject({ method: 'GET', url: `/backups/${pk}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect([...got.rawPayload]).toEqual([9, 8, 7, 0, 255]);
    expect(got.headers['x-backup-version']).toBe(String(v2.json<{ version: number }>().version));
  });

  it('rejects too large, empty and badly addressed backups', async () => {
    const a = relay({ maxBackupBytes: 16 });
    const big = await put(a, Buffer.alloc(17));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect((await put(a, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await put(a, Buffer.from([1]), 'not-a-key')).statusCode).toBe(400);
    expect((await put(a, Buffer.alloc(16))).statusCode).toBe(201);
  });
});
