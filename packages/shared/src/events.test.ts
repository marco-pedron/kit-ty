import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from './canonical.js';
import { nip44Encrypt, sealTripSecret, tripContentKey, tripTagOf } from './content.js';
import {
  buildRegistryEvent,
  decodeContent,
  DEFAULT_INVOICE_EXPIRY_SECONDS,
  encodeContent,
  proposalDigest,
  ProposalSchema,
  readRegistryEvent,
  RegistryFormatError,
  TripParamsSchema,
  type Proposal,
  type RegistryContent,
} from './events.js';
import { KIND_REGISTRY, nostrEventId, type NostrEvent } from './nostr.js';
import { dinner } from './test/samples.js';

const tripId = 'vietnam-2026';
const secret = '5e'.repeat(32);
const trip = { tripId, tripTag: tripTagOf(secret), tripKey: tripContentKey(secret) };
const sk = (n: number) => n.toString(16).padStart(64, '0');
const pk = (n: number) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk(n))));
const [alice, bob, charlie] = [pk(1), pk(2), pk(3)];
const P1 = '1'.repeat(64);
const P2 = '2'.repeat(64);

function sign(e: ReturnType<typeof buildRegistryEvent>, n: number): NostrEvent {
  const id = nostrEventId(e);
  return { ...e, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(sk(n)))) };
}

const params = {
  assetId: 'rgb:dusd',
  assetDecimals: 2,
  displayDecimals: 2,
  silentAssentSeconds: 45,
  invoiceExpirySeconds: DEFAULT_INVOICE_EXPIRY_SECONDS,
  rateMaxAgeSeconds: 86_400,
  oracles: [],
};

const proposal: Proposal = {
  tripId,
  expenseId: 'e1',
  payer: alice,
  receipt: dinner,
  rate: { pair: 'USD/VND', value: '26350', asOf: '2026-10-17T08:00:00.000Z', source: 'table' },
  assetId: 'rgb:dusd',
  assetDecimals: 2,
  total: 968n,
  payerAmount: 309n,
  payerItemIndexes: [0, 2],
  lines: [
    { debtor: bob, amount: 309n, itemIndexes: [0, 2] },
    { debtor: charlie, amount: 350n, itemIndexes: [1, 2] },
  ],
};

const expense: RegistryContent = {
  v: 2,
  tripId,
  type: 'EXPENSE_SUBMITTED',
  body: {
    proposal,
    tableSignatures: [{ signer: bob, sig: 'ab'.repeat(64) }],
    invoices: [
      { debtor: bob, bolt11: 'lnbcrt1bob' },
      { debtor: charlie, bolt11: 'lnbcrt1charlie' },
    ],
    receiptImageSha256: 'c'.repeat(64),
    fingerprint: 'd'.repeat(64),
  },
};

describe('trip params', () => {
  it('accepts the demo values', () => {
    expect(TripParamsSchema.parse(params).assetDecimals).toBe(2);
  });

  it('invoices last 48 h unless the trip says otherwise', () => {
    const rest: Partial<typeof params> = { ...params };
    delete rest.invoiceExpirySeconds;
    expect(TripParamsSchema.parse(rest).invoiceExpirySeconds).toBe(DEFAULT_INVOICE_EXPIRY_SECONDS);
    expect(DEFAULT_INVOICE_EXPIRY_SECONDS).toBe(48 * 3600);
  });

  it('refuses invoices shorter than 24 h', () => {
    expect(TripParamsSchema.safeParse({ ...params, invoiceExpirySeconds: 3600 }).success).toBe(
      false,
    );
  });

  it('refuses more display decimals than the asset has', () => {
    expect(
      TripParamsSchema.safeParse({ ...params, assetDecimals: 2, displayDecimals: 6 }).success,
    ).toBe(false);
  });
});

describe('registry events', () => {
  it('round-trips through a signed Nostr event, encrypted', () => {
    const e = sign(
      buildRegistryEvent({
        author: alice,
        createdAt: 1_760_000_000,
        tripTag: trip.tripTag,
        parents: [P2, P1],
        content: expense,
        tripKey: trip.tripKey,
      }),
      1,
    );
    expect(e.kind).toBe(KIND_REGISTRY);
    expect(e.content).not.toContain('vietnam');
    expect(e.content).not.toContain(bob);
    const read = readRegistryEvent(e, trip);
    expect(read.parents).toEqual([P1, P2]);
    expect(read.author).toBe(alice);
    expect(read.content).toEqual(expense);
  });

  it('only TRIP_CREATED has no parents', () => {
    const created: RegistryContent = {
      v: 2,
      tripId,
      type: 'TRIP_CREATED',
      body: { name: 'Vietnam 2026', params, relays: ['ws://127.0.0.1:7001'] },
    };
    const base = { author: alice, createdAt: 0, tripTag: trip.tripTag, tripKey: trip.tripKey };
    expect(() => buildRegistryEvent({ ...base, parents: [], content: created })).not.toThrow();
    expect(() => buildRegistryEvent({ ...base, parents: [P1], content: created })).toThrow(
      RegistryFormatError,
    );
    expect(() => buildRegistryEvent({ ...base, parents: [], content: expense })).toThrow(
      RegistryFormatError,
    );
  });

  it('refuses events of another trip: tag or content', () => {
    const e = sign(
      buildRegistryEvent({
        author: alice,
        createdAt: 0,
        tripTag: trip.tripTag,
        parents: [P1],
        content: expense,
        tripKey: trip.tripKey,
      }),
      1,
    );
    expect(() => readRegistryEvent(e, { ...trip, tripTag: P2 })).toThrow(RegistryFormatError);
    expect(() => readRegistryEvent(e, { ...trip, tripId: 'other' })).toThrow(RegistryFormatError);
    expect(() =>
      readRegistryEvent(e, { ...trip, tripKey: tripContentKey('77'.repeat(32)) }),
    ).toThrow(RegistryFormatError);
  });

  it('refuses non-canonical JSON inside the encryption', () => {
    const json = JSON.stringify({ type: 'LINE_SEEN', v: 2, tripId, body: { expenseRef: P1 } });
    expect(() => decodeContent(nip44Encrypt(json, trip.tripKey), trip.tripKey, tripId)).toThrow(
      /canonical/,
    );
  });

  it.each([
    ['in an empty body', { v: 2, tripId, type: 'MEMBER_LEFT', body: { note: 'bye' } }],
    ['in a body', { v: 2, tripId, type: 'LINE_SEEN', body: { expenseRef: P1, extra: 1 } }],
    ['next to the body', { v: 2, tripId, type: 'LINE_SEEN', body: { expenseRef: P1 }, x: 1 }],
  ])('refuses unknown fields %s', (_name, content) => {
    const payload = nip44Encrypt(canonicalize(content), trip.tripKey);
    expect(() => decodeContent(payload, trip.tripKey, tripId)).toThrow(RegistryFormatError);
  });

  it('refuses a hidden field in the proposal, which the debtor would not have signed', () => {
    const w = wire(expense) as { body: { proposal: Record<string, unknown> } };
    w.body.proposal.bolt11 = 'lnbcrt1hidden';
    const payload = nip44Encrypt(canonicalize(w), trip.tripKey);
    expect(() => decodeContent(payload, trip.tripKey, tripId)).toThrow(/unknown fields/);
  });

  it('only TRIP_SECRET_SHARED travels in clear, without the trip id', () => {
    const shared: RegistryContent = {
      v: 2,
      tripId,
      type: 'TRIP_SECRET_SHARED',
      body: { recipients: [{ pubkey: alice, ciphertext: sealTripSecret(secret, sk(1), alice) }] },
    };
    const content = encodeContent(shared, trip.tripKey);
    expect(content.startsWith('{')).toBe(true);
    expect(content).not.toContain(tripId);
    expect(decodeContent(content, trip.tripKey, tripId)).toEqual(shared);

    const clearSeen = canonicalize({ v: 2, type: 'LINE_SEEN', body: { expenseRef: P1 } });
    expect(() => decodeContent(clearSeen, trip.tripKey, tripId)).toThrow(/in clear/);
    const encryptedShare = nip44Encrypt(canonicalize(wire(shared)), trip.tripKey);
    expect(() => decodeContent(encryptedShare, trip.tripKey, tripId)).toThrow(/in clear/);
    const withTripId = canonicalize({ ...wire(shared) });
    expect(() => decodeContent(withTripId, trip.tripKey, tripId)).toThrow(/unknown fields/);
  });

  it('refuses a duplicate recipient', () => {
    const shared = {
      v: 2,
      type: 'TRIP_SECRET_SHARED',
      body: {
        recipients: [
          { pubkey: alice, ciphertext: 'x' },
          { pubkey: alice, ciphertext: 'y' },
        ],
      },
    };
    expect(() => decodeContent(canonicalize(shared), trip.tripKey, tripId)).toThrow(
      RegistryFormatError,
    );
  });
});

describe('table signatures (D2)', () => {
  it('sign the proposal, which has no invoice', () => {
    expect(Object.keys(ProposalSchema.shape)).not.toContain('bolt11');
    expect(Object.keys(ProposalSchema.shape.lines.element.shape)).not.toContain('bolt11');
  });

  it('stay valid when the payer reissues an invoice', () => {
    const before = proposalDigest(proposal);
    const reissued = { ...expense.body, invoices: [{ debtor: bob, bolt11: 'lnbcrt1new' }] };
    expect(reissued.proposal).toBe(proposal);
    expect(proposalDigest(reissued.proposal)).toBe(before);
  });

  it('change with any amount, line or rate', () => {
    const d = proposalDigest(proposal);
    expect(proposalDigest({ ...proposal, payerAmount: 310n })).not.toBe(d);
    expect(proposalDigest({ ...proposal, rate: { ...proposal.rate, value: '26351' } })).not.toBe(d);
    expect(proposalDigest({ ...proposal, lines: proposal.lines.slice(0, 1) })).not.toBe(d);
  });

  it('is domain-separated from a plain hash of the proposal', () => {
    const wireProposal = canonicalize(wire(proposal));
    expect(proposalDigest(proposal)).toBe(sha256Hex(`kitty:share:v1${wireProposal}`));
    expect(proposalDigest(proposal)).not.toBe(sha256Hex(wireProposal));
  });
});

// The wire form (bigint → decimal string), as encodeContent writes it.
function wire(c: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(c, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)));
}
