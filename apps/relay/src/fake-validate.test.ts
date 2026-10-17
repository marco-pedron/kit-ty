import { describe, expect, it } from 'vitest';
import { openRelayDb } from './db.js';
import { fakeModeValidate } from './fake-validate.js';
import { createEventLog } from './log.js';
import { defaultDeps } from './server.js';
import { aliceJoined, rateSet, tripCreated, wire } from './test/helpers.js';

// The relay as `pnpm dev:fakes` builds it: permissive validator, default deps (whose verifier
// and invoice decoder are still stubs, and must never be reached).
const setup = () =>
  createEventLog({ db: openRelayDb(':memory:'), validate: fakeModeValidate, deps: defaultDeps });

describe('fake mode validator (KITTY_FAKES=1)', () => {
  it('accepts events without checking signatures, and chains them', () => {
    const log = setup();
    const created = tripCreated();
    created.sig = 'not-a-signature';
    const a = log.append(wire(created));
    const b = log.append(wire(aliceJoined()));
    if (!a.ok || !b.ok) throw new Error(`expected accepted: ${JSON.stringify([a, b])}`);
    expect(b.stored.prevHash).toBe(a.stored.hash);
    expect(log.list()).toHaveLength(2);
  });

  it('still requires TRIP_CREATED first and only once', () => {
    const log = setup();
    expect(log.append(wire(rateSet()))).toMatchObject({ ok: false, status: 409 });
    expect(log.append(wire(tripCreated())).ok).toBe(true);
    expect(log.append(wire(tripCreated()))).toMatchObject({
      ok: false,
      error: { message: 'the trip already exists' },
    });
  });

  it('still rejects another trip, a duplicate nonce and a malformed event', () => {
    const log = setup();
    const created = tripCreated();
    log.append(wire(created));
    const other = rateSet();
    other.inner.tripId = 'other-trip';
    expect(log.append(wire(other))).toMatchObject({ ok: false, error: { code: 'INVALID_EVENT' } });
    const replay = rateSet();
    replay.inner.nonce = created.inner.nonce;
    expect(log.append(wire(replay))).toMatchObject({ ok: false, error: { code: 'INVALID_EVENT' } });
    expect(log.append({ inner: {}, sig: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(log.list()).toHaveLength(1);
  });

  it('rejects a broken chain', () => {
    const log = setup();
    const r = log.append(wire(tripCreated()));
    if (!r.ok) throw new Error('expected accepted');
    const forged = { ...r.stored, seq: 2 };
    expect(fakeModeValidate(forged, null, defaultDeps)).toMatchObject({ ok: false });
    expect(
      fakeModeValidate({ ...r.stored, hash: 'f'.repeat(64) }, null, defaultDeps),
    ).toMatchObject({ ok: false, reason: 'bad hash' });
  });
});
