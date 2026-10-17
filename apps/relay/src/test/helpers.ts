import type { ValidationDeps } from '@kitty/ledger';
import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  GENESIS_HASH,
  sha256Hex,
  signingMessage,
  storedEventHash,
  type EventBody,
  type EventInner,
  type EventType,
  type SignedEvent,
  SignedEventSchema,
} from '@kitty/shared';
import { z } from 'zod';
import type { Validate } from '../log.js';

// Test-only signatures: sha256 of author and message. Forgeable on purpose; the real verifier
// is task B4 and the real validateEvent is task A2.

export const KEY = {
  alice: 'a'.repeat(64),
  bob: 'b'.repeat(64),
  dave: 'd'.repeat(64),
} as const;

export const testSign = (author: string, message: string) =>
  sha256Hex(`kitty-relay-test:${author}:${message}`);

export const testDeps: ValidationDeps = {
  verify: { verify: (author, message, sig) => testSign(author, message) === sig },
  decodeInvoice: () => {
    throw new Error('decodeInvoice is not used by the relay tests');
  },
};

/**
 * A stand-in for the ledger's validateEvent (task A2), so C1 does not wait for it. It checks
 * what the relay depends on: signature, chain, nonce, and that the log opens with TRIP_CREATED.
 */
export const fakeValidate: Validate = (stored, trip, deps) => {
  const { inner, sig } = stored.signed;
  if (!deps.verify.verify(inner.author, signingMessage(inner), sig))
    return { ok: false, code: 'INVALID_EVENT', reason: 'bad signature' };
  if (trip === null && inner.type !== 'TRIP_CREATED')
    return { ok: false, code: 'INVALID_EVENT', reason: 'the log must open with TRIP_CREATED' };
  if (trip?.noncesSeen.has(inner.nonce))
    return { ok: false, code: 'INVALID_EVENT', reason: 'nonce already seen' };
  const expectedSeq = (trip?.head?.seq ?? 0) + 1;
  const expectedPrev = trip?.head?.hash ?? GENESIS_HASH;
  if (stored.seq !== expectedSeq || stored.prevHash !== expectedPrev)
    return { ok: false, code: 'INVALID_EVENT', reason: 'broken chain' };
  if (stored.hash !== storedEventHash(stored))
    return { ok: false, code: 'INVALID_EVENT', reason: 'bad hash' };
  return { ok: true };
};

let counter = 0;
export const freshNonce = () => (counter++).toString(16).padStart(32, '0');

export function signed<T extends EventType>(
  type: T,
  author: string,
  body: EventBody<T>,
  over: Partial<Pick<EventInner, 'nonce' | 'tripId'>> = {},
): SignedEvent {
  const inner = {
    v: 1,
    tripId: over.tripId ?? 'vietnam-2026',
    type,
    author,
    nonce: over.nonce ?? freshNonce(),
    createdAt: '2026-10-17T12:00:00.000Z',
    body,
  } as EventInner;
  return { inner, sig: testSign(author, signingMessage(inner)) };
}

/** Wire form, as an agent would POST it. */
export const wire = (e: SignedEvent) => z.encode(SignedEventSchema, e);

export const tripCreated = () =>
  signed('TRIP_CREATED', KEY.dave, {
    name: 'Vietnam 2026',
    assetId: 'rgb:dusd',
    params: DEMO_TRIP_PARAMS,
    coordinatorPubkey: KEY.dave,
  });

export const rateSet = () =>
  signed('RATE_SET', KEY.dave, {
    asOf: '2026-10-17',
    source: 'infra/rates.json',
    rates: { VND: '26350' },
  });

export const aliceJoined = () =>
  signed('MEMBER_JOINED', KEY.alice, {
    displayName: 'alice',
    memberId: 'alice',
    appPubkey: KEY.alice,
    nodePubkey: `02${KEY.alice}`,
    bindInvoice: 'lnbcrt1bindalice',
    policy: DEFAULT_POLICY,
  });
