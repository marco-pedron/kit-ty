import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_POLICY, DEMO_TRIP_PARAMS } from './domain.js';
import {
  EVENT_AUTHOR,
  EVENT_TYPES,
  EventInnerSchema,
  GENESIS_HASH,
  StoredEventSchema,
  signingMessage,
  storedEventHash,
  type EventBody,
  type EventInner,
  type EventType,
} from './events.js';
import { AT, HASH, NODE, dinner } from './test/samples.js';

const BOLT11 = 'lnbcrt30u1pexample';
const ref = { expenseEventHash: HASH('e') };

// One valid body per event type (SPEC §9.2).
const bodies: { [T in EventType]: EventBody<T> } = {
  TRIP_CREATED: {
    name: 'Vietnam 2026',
    assetId: 'rgb:dusd',
    params: DEMO_TRIP_PARAMS,
    coordinatorPubkey: HASH('d'),
  },
  RATE_SET: { asOf: '2026-10-17', source: 'infra/rates.json', rates: { VND: '26350' } },
  MEMBER_JOINED: {
    displayName: 'Bob',
    memberId: 'bob',
    appPubkey: HASH('b'),
    nodePubkey: NODE('b'),
    bindInvoice: BOLT11,
    policy: DEFAULT_POLICY,
  },
  MEMBER_ADMITTED: { memberPubkey: HASH('b') },
  POLICY_UPDATED: { policy: { ...DEFAULT_POLICY, payUpheldDisputes: true } },
  CHANNELS_READY: { memberPubkey: HASH('b'), tripChannelId: 'c1', liquidityChannelId: 'c2' },
  EXPENSE_SUBMITTED: {
    expenseId: 'e1',
    receipt: dinner,
    receiptImageSha256: HASH('f'),
    rateEventHash: HASH('9'),
    rate: '26350',
    totalUsdCents: 968n,
    payerCents: 309n,
    payerItemIndexes: [0, 2],
    lines: [
      { debtorPubkey: HASH('b'), cents: 309n, itemIndexes: [0, 2], bolt11: BOLT11 },
      { debtorPubkey: HASH('c'), cents: 350n, itemIndexes: [1, 2], bolt11: BOLT11 },
    ],
    fingerprint: HASH('8'),
  },
  LINE_SEEN: ref,
  LINE_DECIDED: { ...ref, decision: 'contest', cents: 350n, reason: 'I only had water' },
  PAYMENT_MADE: {
    ...ref,
    creditorPubkey: HASH('a'),
    cents: 309n,
    rail: 'ln',
    paymentHash: HASH('1'),
    preimage: HASH('2'),
  },
  EXPENSE_VOIDED: ref,
  DISPUTE_RESOLVED: { ...ref, debtorPubkey: HASH('c'), outcome: 'upheld', note: 'photo seen' },
  INVOICE_REISSUED: { ...ref, debtorPubkey: HASH('c'), bolt11: BOLT11 },
  GUARANTEE_PAID: {
    ...ref,
    debtorPubkey: HASH('c'),
    creditorPubkey: HASH('a'),
    cents: 350n,
    paymentHash: HASH('3'),
    preimage: HASH('4'),
  },
  MEMBER_EXCLUDED: { memberPubkey: HASH('c'), reason: 'did not pay', closingTxids: [HASH('5')] },
  CHECKPOINT: { seq: 12, headHash: HASH('6') },
  TRIP_CLOSED: { summary: 'all settled' },
};

function inner<T extends EventType>(type: T, author = HASH('a')): EventInner {
  return {
    v: 1,
    tripId: 'vietnam-2026',
    type,
    author,
    nonce: '0123456789abcdef0123456789abcdef',
    createdAt: AT,
    body: bodies[type],
  } as EventInner;
}

describe('event schemas', () => {
  it('cover every type of SPEC §9.2 and give each an author rule', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(bodies).sort());
    expect(Object.keys(EVENT_AUTHOR).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('%s survives encode → JSON → decode with bigint intact', (type) => {
    const e = inner(type);
    const wire = JSON.parse(JSON.stringify(z.encode(EventInnerSchema, e)));
    expect(z.decode(EventInnerSchema, wire)).toEqual(e);
  });

  it('puts amounts on the wire as decimal strings', () => {
    const wire = z.encode(EventInnerSchema, inner('EXPENSE_SUBMITTED')) as {
      body: { totalUsdCents: unknown; lines: { cents: unknown }[] };
    };
    expect(wire.body.totalUsdCents).toBe('968');
    expect(wire.body.lines[0]?.cents).toBe('309');
  });

  it('rejects an unknown type, a bad nonce and an ln payment without preimage', () => {
    const wire = z.encode(EventInnerSchema, inner('PAYMENT_MADE')) as Record<string, unknown>;
    expect(EventInnerSchema.safeParse({ ...wire, type: 'STEAL' }).success).toBe(false);
    expect(EventInnerSchema.safeParse({ ...wire, nonce: 'abc' }).success).toBe(false);
    const body = { ...(wire.body as Record<string, unknown>) };
    delete body.preimage;
    expect(EventInnerSchema.safeParse({ ...wire, body }).success).toBe(false);
  });

  it('rejects amounts written as JSON numbers', () => {
    const wire = z.encode(EventInnerSchema, inner('LINE_DECIDED')) as Record<string, unknown>;
    const body = { ...(wire.body as Record<string, unknown>), cents: 350 };
    expect(EventInnerSchema.safeParse({ ...wire, body }).success).toBe(false);
  });
});

describe('signing message and chain hash', () => {
  it('is the same for the decoded event and its wire form', () => {
    const e = inner('EXPENSE_SUBMITTED');
    const decoded = z.decode(
      EventInnerSchema,
      JSON.parse(JSON.stringify(z.encode(EventInnerSchema, e))),
    );
    expect(signingMessage(decoded)).toBe(signingMessage(e));
    expect(signingMessage(e)).toContain('"totalUsdCents":"968"');
  });

  it('changes with any field, so a signature cannot be moved to another trip', () => {
    const e = inner('LINE_SEEN');
    expect(signingMessage({ ...e, tripId: 'other-trip' })).not.toBe(signingMessage(e));
  });

  it('chains: the hash depends on seq and prevHash', () => {
    const signed = { inner: inner('LINE_SEEN'), sig: 'sig' };
    const h1 = storedEventHash({ seq: 1, prevHash: GENESIS_HASH, signed });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(storedEventHash({ seq: 2, prevHash: GENESIS_HASH, signed })).not.toBe(h1);
    expect(storedEventHash({ seq: 1, prevHash: HASH('1'), signed })).not.toBe(h1);
    const stored = { seq: 1, prevHash: GENESIS_HASH, signed, receivedAt: AT, hash: h1 };
    expect(StoredEventSchema.safeParse(z.encode(StoredEventSchema, stored)).success).toBe(true);
  });
});
