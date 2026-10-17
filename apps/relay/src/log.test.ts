import { GENESIS_HASH, storedEventHash } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { openRelayDb } from './db.js';
import { createEventLog } from './log.js';
import { aliceJoined, fakeValidate, rateSet, testDeps, tripCreated, wire } from './test/helpers.js';

const setup = () => {
  const db = openRelayDb(':memory:');
  const log = createEventLog({ db, validate: fakeValidate, deps: testDeps });
  return { db, log };
};

describe('event log', () => {
  it('accepts a valid event and chains it', () => {
    const { log } = setup();
    const a = log.append(wire(tripCreated()));
    const b = log.append(wire(rateSet()));
    if (!a.ok || !b.ok) throw new Error('expected both accepted');
    expect(a.stored.seq).toBe(1);
    expect(a.stored.prevHash).toBe(GENESIS_HASH);
    expect(b.stored.seq).toBe(2);
    expect(b.stored.prevHash).toBe(a.stored.hash);
    for (const s of [a.stored, b.stored]) expect(s.hash).toBe(storedEventHash(s));
    expect(log.list().map((e) => e.hash)).toEqual([a.stored.hash, b.stored.hash]);
    expect(log.list(1).map((e) => e.seq)).toEqual([2]);
  });

  it('round-trips bigints through storage', () => {
    const { log } = setup();
    log.append(wire(tripCreated()));
    const [e] = log.list();
    if (e?.signed.inner.type !== 'TRIP_CREATED') throw new Error('expected TRIP_CREATED');
    expect(typeof e.signed.inner.body.params.guaranteeCapCents).toBe('bigint');
  });

  it('rejects an altered event and stores nothing', () => {
    const { log } = setup();
    const e = tripCreated();
    e.inner.createdAt = '2026-10-17T12:00:01.000Z';
    const r = log.append(wire(e));
    expect(r).toMatchObject({ ok: false, status: 409, error: { code: 'INVALID_EVENT' } });
    expect(log.list()).toEqual([]);
  });

  it('rejects a duplicate nonce', () => {
    const { log } = setup();
    const first = tripCreated();
    expect(log.append(wire(first)).ok).toBe(true);
    const replay = rateSet();
    replay.inner.nonce = first.inner.nonce;
    expect(log.append(wire(replay))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_EVENT', message: 'nonce already used in this trip' },
    });
    expect(log.list()).toHaveLength(1);
  });

  it('rejects an event of another trip', () => {
    const { log } = setup();
    log.append(wire(tripCreated()));
    const other = rateSet();
    other.inner.tripId = 'other-trip';
    expect(log.append(wire(other))).toMatchObject({ ok: false, error: { code: 'INVALID_EVENT' } });
  });

  it('rejects what the ledger rejects', () => {
    const { log } = setup();
    expect(log.append(wire(aliceJoined()))).toMatchObject({
      ok: false,
      error: { message: 'the log must open with TRIP_CREATED' },
    });
  });

  it('answers 400 to a body that is not a signed event', () => {
    const { log } = setup();
    expect(log.append({ inner: { type: 'NOPE' } })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('answers 501 while the real validateEvent is a stub, and stores nothing', () => {
    const db = openRelayDb(':memory:');
    const log = createEventLog({ db, deps: testDeps });
    expect(log.append(wire(tripCreated()))).toMatchObject({
      ok: false,
      status: 501,
      error: { code: 'NOT_IMPLEMENTED' },
    });
    expect(log.list()).toEqual([]);
  });

  it('notifies listeners of accepted events only', () => {
    const { log } = setup();
    const seen: number[] = [];
    const off = log.onAppend((s) => seen.push(s.seq));
    log.append(wire(tripCreated()));
    log.append({ bad: true });
    off();
    log.append(wire(rateSet()));
    expect(seen).toEqual([1]);
  });
});

describe('storage is append-only', () => {
  it('aborts UPDATE and DELETE on events and backups', () => {
    const { db, log } = setup();
    log.append(wire(tripCreated()));
    db.putBackup('a'.repeat(64), new Uint8Array([1]), '2026-10-17T12:00:00.000Z');
    expect(() => db.raw.exec("UPDATE events SET type = 'X'")).toThrow(/append-only/);
    expect(() => db.raw.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(() => db.raw.exec('UPDATE backups SET pubkey = 0')).toThrow(/append-only/);
    expect(() => db.raw.exec('DELETE FROM backups')).toThrow(/append-only/);
    expect(log.list()).toHaveLength(1);
  });

  it('enforces unique nonces in the schema too', () => {
    const { db, log } = setup();
    log.append(wire(tripCreated()));
    const [row] = db.listEvents();
    if (!row) throw new Error('expected a row');
    expect(() => db.insertEvent({ ...row, seq: 2, hash: 'f'.repeat(64) })).toThrow(/UNIQUE/);
  });
});
