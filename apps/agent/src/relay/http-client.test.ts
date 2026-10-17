import type { StoredEvent } from '@kitty/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
// The real relay, in memory (tests only: apps never import each other).
import { openRelayDb, type RelayDb } from '../../../relay/src/db.js';
import { fakeModeValidate } from '../../../relay/src/fake-validate.js';
import { buildRelay } from '../../../relay/src/server.js';
import { rateSet, tripCreated, wire } from '../../../relay/src/test/helpers.js';
import { RelayError } from './errors.js';
import { createRelayClient } from './http-client.js';
import type { RelayStatus } from './types.js';

const running: FastifyInstance[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  stops.splice(0).forEach((s) => s());
  await Promise.all(running.splice(0).map((a) => a.close()));
});

async function startRelay(db: RelayDb = openRelayDb(':memory:'), port = 0) {
  const app = buildRelay({ logger: false, db, validate: fakeModeValidate, maxBackupBytes: 1024 });
  running.push(app);
  const url = await app.listen({ host: '127.0.0.1', port });
  return { app, db, url, port: Number(new URL(url).port) };
}

// inject() takes the wire form (bigints as strings), as the agent sends it.
const wireOf = (e: Parameters<typeof wire>[0]) => wire(e) as object;
const fast = { backoff: { initialMs: 20, maxMs: 100 }, timeoutMs: 2_000 };

async function waitFor(cond: () => boolean, what: string, ms = 5_000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => {
      if (!(e instanceof RelayError)) throw e;
      return e;
    },
  );

/** A free port: listen on 0, close. */
async function freePort() {
  const { app, port } = await startRelay();
  await app.close();
  running.splice(running.indexOf(app), 1);
  return port;
}

describe('RelayClient against the real relay', () => {
  it('appends and lists', async () => {
    const { url } = await startRelay();
    const relay = createRelayClient({ baseUrl: `${url}/`, ...fast });
    const a = await relay.append(tripCreated());
    const b = await relay.append(rateSet());
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b.prevHash).toBe(a.hash);
    expect((await relay.list()).map((e) => e.seq)).toEqual([1, 2]);
    expect((await relay.list(1)).map((e) => e.hash)).toEqual([b.hash]);
  });

  it("reports the relay's refusal with its code and reason", async () => {
    const { url } = await startRelay();
    const relay = createRelayClient({ baseUrl: url, ...fast });
    const first = tripCreated();
    await relay.append(first);
    const replay = rateSet();
    replay.inner.nonce = first.inner.nonce;
    const err = await rejection(relay.append(replay));
    expect(err).toMatchObject({ code: 'INVALID_EVENT', httpStatus: 409 });
    expect(err.message).toMatch(/nonce/);
    expect(err.toApiError().action).toEqual(expect.any(String));
  });

  it('says RELAY_UNREACHABLE when nobody answers', async () => {
    const relay = createRelayClient({ baseUrl: `http://127.0.0.1:${await freePort()}`, ...fast });
    const errors = await Promise.all(
      [relay.append(tripCreated()), relay.list(), relay.getBackup('b'.repeat(64))].map(rejection),
    );
    for (const err of errors) {
      expect(err).toMatchObject({ code: 'RELAY_UNREACHABLE', httpStatus: null });
    }
  });

  it('stores and fetches opaque backups', async () => {
    const { url } = await startRelay();
    const relay = createRelayClient({ baseUrl: url, ...fast });
    const pk = 'b'.repeat(64);
    expect(await relay.getBackup(pk)).toBeNull();
    await relay.putBackup(pk, Uint8Array.from([1, 2, 3]));
    await relay.putBackup(pk, Uint8Array.from([0, 255, 7]));
    expect(await relay.getBackup(pk)).toEqual(Uint8Array.from([0, 255, 7]));
    expect(await rejection(relay.putBackup(pk, new Uint8Array(2048)))).toMatchObject({
      code: 'VALIDATION_ERROR',
      httpStatus: 413,
    });
  });
});

describe('RelayClient.subscribe against the real relay', () => {
  function collect(relay: ReturnType<typeof createRelayClient>, sinceSeq?: number) {
    const seqs: number[] = [];
    const statuses: RelayStatus['state'][] = [];
    stops.push(
      relay.subscribe((e: StoredEvent) => seqs.push(e.seq), {
        ...(sinceSeq !== undefined && { sinceSeq }),
        onStatus: (s) => statuses.push(s.state),
      }),
    );
    return { seqs, statuses };
  }

  it('delivers the backlog after sinceSeq, then live events', async () => {
    const { url } = await startRelay();
    const relay = createRelayClient({ baseUrl: url, ...fast });
    await relay.append(tripCreated());
    await relay.append(rateSet());
    const { seqs, statuses } = collect(relay, 1);
    await waitFor(() => seqs.length === 1, 'backlog');
    await relay.append(rateSet());
    await waitFor(() => seqs.length === 2, 'live event');
    expect(seqs).toEqual([2, 3]);
    expect(statuses).toEqual(['connected']);
  });

  it('reconnects after a relay restart and catches up, with no gaps or duplicates', async () => {
    const first = await startRelay();
    const relay = createRelayClient({ baseUrl: first.url, ...fast });
    await relay.append(tripCreated());
    const { seqs, statuses } = collect(relay);
    await waitFor(() => seqs.length === 1, 'first event');

    await first.app.close();
    running.splice(running.indexOf(first.app), 1);
    await waitFor(() => statuses.includes('reconnecting'), 'reconnecting');

    // Same database, same port: events appended while the client was away.
    const second = await startRelay(first.db, first.port);
    await second.app.inject({ method: 'POST', url: '/events', payload: wireOf(rateSet()) });
    await second.app.inject({ method: 'POST', url: '/events', payload: wireOf(rateSet()) });
    await waitFor(() => seqs.length === 3, 'catch-up');
    await relay.append(rateSet());
    await waitFor(() => seqs.length === 4, 'live after reconnect');
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(statuses.at(-1)).toBe('connected');
  });

  it('keeps retrying while the relay is down at start', async () => {
    const port = await freePort();
    const relay = createRelayClient({ baseUrl: `http://127.0.0.1:${port}`, ...fast });
    const { seqs, statuses } = collect(relay);
    await waitFor(() => statuses.filter((s) => s === 'reconnecting').length >= 2, 'retries');
    const { app } = await startRelay(openRelayDb(':memory:'), port);
    await app.inject({ method: 'POST', url: '/events', payload: wireOf(tripCreated()) });
    await waitFor(() => seqs.length === 1, 'event after the relay came up');
    expect(statuses.at(-1)).toBe('connected');
  });

  it('stops delivering after unsubscribe', async () => {
    const { url } = await startRelay();
    const relay = createRelayClient({ baseUrl: url, ...fast });
    const seqs: number[] = [];
    const stop = relay.subscribe((e) => seqs.push(e.seq));
    await relay.append(tripCreated());
    await waitFor(() => seqs.length === 1, 'first event');
    stop();
    await relay.append(rateSet());
    await new Promise((r) => setTimeout(r, 100));
    expect(seqs).toEqual([1]);
  });
});
