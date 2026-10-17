import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { expenseFingerprint, expenseShares } from '@kitty/ledger';
import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  sha256Hex,
  signingMessage,
  type EventBody,
  type EventInner,
  type EventType,
  type Receipt,
  type SignedEvent,
} from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { openRelayDb } from './db.js';
import { createEventLog, type EventLog } from './log.js';
import { defaultDeps } from './server.js';
import { encodeBolt11 } from './test/bolt11-encode.js';
import { wire } from './test/helpers.js';

// The relay as it runs without fakes: the ledger's validateEvent with defaultDeps, i.e. the
// real ed25519 verifier (B4) and the JS BOLT11 decoder. Real keys, real signed invoices.

const ASSET = 'rgb:CJkb4YZw-jRiz2sk-~PARPio-wtVYI1c-XAEYCqO-wTfvRZ8';
const TRIP = 'vietnam-2026';

const actor = () => {
  const app = ed25519.utils.randomSecretKey();
  const node = secp256k1.utils.randomSecretKey();
  return {
    app,
    node,
    pub: bytesToHex(ed25519.getPublicKey(app)),
    nodePub: bytesToHex(secp256k1.getPublicKey(node)),
  };
};
const dave = actor();
const alice = actor();
const bob = actor();
const charlie = actor();

let nonce = 0;
function sign<T extends EventType>(who: typeof dave, type: T, body: EventBody<T>): SignedEvent {
  const inner = {
    v: 1,
    tripId: TRIP,
    type,
    author: who.pub,
    nonce: (nonce++).toString(16).padStart(32, '0'),
    createdAt: new Date().toISOString(),
    body,
  } as EventInner;
  return { inner, sig: bytesToHex(ed25519.sign(utf8ToBytes(signingMessage(inner)), who.app)) };
}

const now = () => Math.floor(Date.now() / 1000);
const invoice = (
  signer: typeof alice,
  description: string,
  extra: Partial<Parameters<typeof encodeBolt11>[0]> = {},
) =>
  encodeBolt11({
    nodeSecret: signer.node,
    timestampSec: now(),
    paymentHash: secp256k1.utils.randomSecretKey(),
    description,
    ...extra,
  });
const bindInvoice = (who: typeof alice, signer = who) =>
  invoice(signer, `kitty-bind:${sha256Hex(who.pub)}`);

const joined = (who: typeof alice, memberId: 'alice' | 'bob' | 'charlie', bind: string) =>
  sign(who, 'MEMBER_JOINED', {
    displayName: memberId,
    memberId,
    appPubkey: who.pub,
    nodePubkey: who.nodePub,
    bindInvoice: bind,
    policy: DEFAULT_POLICY,
  });

const ok = (log: EventLog, e: SignedEvent) => {
  const r = log.append(wire(e));
  if (!r.ok) throw new Error(`${e.inner.type} rejected: ${r.error.message}`);
  return r.stored;
};
const reason = (log: EventLog, e: SignedEvent) => {
  const r = log.append(wire(e));
  return r.ok ? 'accepted' : r.error.message;
};

/** TRIP_CREATED, RATE_SET, alice and bob joined with valid bind invoices and admitted. */
function trip() {
  const log = createEventLog({ db: openRelayDb(':memory:'), deps: defaultDeps });
  ok(
    log,
    sign(dave, 'TRIP_CREATED', {
      name: 'Vietnam 2026',
      assetId: ASSET,
      params: DEMO_TRIP_PARAMS,
      coordinatorPubkey: dave.pub,
    }),
  );
  const rate = ok(
    log,
    sign(dave, 'RATE_SET', {
      asOf: '2026-10-17',
      source: 'infra/rates.json',
      rates: { VND: '26350' },
    }),
  );
  for (const [who, id] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    ok(log, joined(who, id, bindInvoice(who)));
    ok(log, sign(dave, 'MEMBER_ADMITTED', { memberPubkey: who.pub }));
  }
  return { log, rateEventHash: rate.hash };
}

const dinner: Receipt = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    { label: 'Bia Saigon', quantity: 1, unitPrice: 25_000n, total: 25_000n },
  ],
  total: 155_000n,
  warnings: [],
};

/** Alice paid; she and bob share the pho, bob had the beer. `line` overrides the invoice. */
function expense(rateEventHash: string, bolt11?: (cents: bigint) => string) {
  const receiptImageSha256 = 'e'.repeat(64);
  const shares = expenseShares({
    receipt: dinner,
    rate: '26350',
    payer: alice.pub,
    payerItemIndexes: [0],
    debtors: [{ id: bob.pub, itemIndexes: [0, 1] }],
  });
  const cents = shares.debtors[0]!.cents;
  const description = `kitty:${TRIP}:e1:bob`;
  return sign(alice, 'EXPENSE_SUBMITTED', {
    expenseId: 'e1',
    receipt: dinner,
    receiptImageSha256,
    rateEventHash,
    rate: '26350',
    totalUsdCents: shares.totalUsdCents,
    payerCents: shares.payerCents,
    payerItemIndexes: [0],
    lines: [
      {
        debtorPubkey: bob.pub,
        cents,
        itemIndexes: [0, 1],
        bolt11:
          bolt11?.(cents) ?? invoice(alice, description, { assetId: ASSET, assetAmount: cents }),
      },
    ],
    fingerprint: expenseFingerprint(dinner, receiptImageSha256),
  });
}

describe('relay with the real validateEvent, ed25519 and BOLT11 decoder', () => {
  it('accepts members whose bind invoice comes from their own node', () => {
    const { log } = trip();
    expect(log.list().map((e) => e.signed.inner.type)).toEqual([
      'TRIP_CREATED',
      'RATE_SET',
      'MEMBER_JOINED',
      'MEMBER_ADMITTED',
      'MEMBER_JOINED',
      'MEMBER_ADMITTED',
    ]);
  });

  it('rejects a bind invoice from another node, or naming a node that did not sign it', () => {
    const { log } = trip();
    // Signed by bob's node: its payee is bob's node, not the one charlie claims.
    expect(reason(log, joined(charlie, 'charlie', bindInvoice(charlie, bob)))).toBe(
      'bind invoice is from another node',
    );
    // Names charlie's node as payee but is signed by bob's node (SPEC §13 #1).
    const forged = invoice(bob, `kitty-bind:${sha256Hex(charlie.pub)}`, {
      payee: secp256k1.getPublicKey(charlie.node),
    });
    expect(reason(log, joined(charlie, 'charlie', forged))).toMatch(
      /invoice not decodable.*signature does not match the payee/,
    );
    // A bind invoice for another app key.
    const wrongKey = invoice(charlie, `kitty-bind:${sha256Hex(bob.pub)}`);
    expect(reason(log, joined(charlie, 'charlie', wrongKey))).toBe(
      'bind invoice does not commit to the appPubkey',
    );
    expect(reason(log, joined(charlie, 'charlie', bindInvoice(charlie)))).toBe('accepted');
  });

  it('accepts an expense whose invoices are for the trip asset and the line amount', () => {
    const { log, rateEventHash } = trip();
    expect(reason(log, expense(rateEventHash))).toBe('accepted');
  });

  it('rejects an expense invoice for another asset, amount, payee, description or a mainnet one', () => {
    const { log, rateEventHash } = trip();
    const d = `kitty:${TRIP}:e1:bob`;
    const OTHER = 'rgb:ZfUYO5Cr-Rp_3oXd-eZZwd54-zLGX3Js-3liqx0G-D~eGyvQ';
    const cases: [(cents: bigint) => string, RegExp][] = [
      [(c) => invoice(alice, d, { assetId: OTHER, assetAmount: c }), /not for the trip asset/],
      [(c) => invoice(alice, d, { assetId: ASSET, assetAmount: c - 1n }), /is not for \d+ cents/],
      [(c) => invoice(bob, d, { assetId: ASSET, assetAmount: c }), /payable to another node/],
      [(c) => invoice(alice, 'kitty:x', { assetId: ASSET, assetAmount: c }), /wrong description/],
      [
        (c) => invoice(alice, d, { hrp: 'lnbc30u', assetId: ASSET, assetAmount: c }),
        /regtest only/,
      ],
      [
        (c) => invoice(alice, d, { assetId: ASSET, assetAmount: c, timestampSec: now() - 7200 }),
        /already expired/,
      ],
    ];
    for (const [bolt11, why] of cases)
      expect(reason(log, expense(rateEventHash, bolt11))).toMatch(why);
    expect(log.list()).toHaveLength(6);
  });
});
