import { GENESIS_HASH, storedEventHash } from '@kitty/shared';
import type { Validate } from './log.js';

// KITTY_FAKES=1 only: a permissive stand-in for the ledger's validateEvent, so the fakes
// checkpoint (I1) does not wait for A2 and B4. It checks the chain (seq, prevHash, hash), that
// the log opens with TRIP_CREATED, the trip id and fresh nonces. It does NOT check signatures,
// invoices or any ledger rule: never use it outside fakes. The event shape is already checked
// by the log (SignedEventSchema) before this runs.

export const FAKE_MODE_WARNING = 'relay in FAKE mode: signatures and invoices are not verified';

export const fakeModeValidate: Validate = (stored, trip) => {
  const { inner } = stored.signed;
  const fail = (reason: string) => ({ ok: false as const, code: 'INVALID_EVENT' as const, reason });
  if (trip === null) {
    if (inner.type !== 'TRIP_CREATED') return fail('the log must open with TRIP_CREATED');
  } else {
    if (inner.type === 'TRIP_CREATED') return fail('the trip already exists');
    if (inner.tripId !== trip.tripId) return fail(`this relay serves trip ${trip.tripId}`);
    if (trip.noncesSeen.has(inner.nonce)) return fail('nonce already seen');
  }
  const expectedSeq = (trip?.head?.seq ?? 0) + 1;
  const expectedPrev = trip?.head?.hash ?? GENESIS_HASH;
  if (stored.seq !== expectedSeq || stored.prevHash !== expectedPrev) return fail('broken chain');
  if (stored.hash !== storedEventHash(stored)) return fail('bad hash');
  return { ok: true };
};
