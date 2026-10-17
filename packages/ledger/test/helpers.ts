import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  GENESIS_HASH,
  storedEventHash,
  type EventBody,
  type EventInner,
  type EventType,
  type MemberId,
  type Receipt,
  type StoredEvent,
} from '@kitty/shared';
import { expenseShares } from '../src/index.js';

// Builders for a signed log with a real hash chain. Signatures are placeholders: deriveTrip
// trusts events already validated (validateEvent, task A2, checks them).

export const KEY = {
  alice: 'a'.repeat(64),
  bob: 'b'.repeat(64),
  charlie: 'c'.repeat(64),
  dave: 'd'.repeat(64),
} as const;
export const NODE = (k: string) => `02${k}`;
export const T0 = Date.parse('2026-10-17T12:00:00.000Z');
/** The instant `s` seconds after T0. */
export const at = (s: number) => new Date(T0 + s * 1000);
export const hex = (c: string) => c.repeat(64).slice(0, 64);

export const dinner: Receipt = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    { label: 'Bia Saigon x3', quantity: 3, unitPrice: 25_000n, total: 75_000n },
    { label: 'Water', quantity: 3, unitPrice: 10_000n, total: 30_000n },
  ],
  subtotal: 235_000n,
  tip: 20_000n,
  total: 255_000n,
  warnings: [],
};

export class Log {
  readonly events: StoredEvent[] = [];
  private nonce = 0;

  push<T extends EventType>(type: T, author: string, body: EventBody<T>, s: number): StoredEvent {
    const inner = {
      v: 1,
      tripId: 'vietnam-2026',
      type,
      author,
      nonce: (this.nonce++).toString(16).padStart(32, '0'),
      createdAt: at(s).toISOString(),
      body,
    } as EventInner;
    const seq = this.events.length + 1;
    const prevHash = this.events.at(-1)?.hash ?? GENESIS_HASH;
    const signed = { inner, sig: 'test-signature' };
    const stored: StoredEvent = {
      seq,
      prevHash,
      signed,
      receivedAt: at(s).toISOString(),
      hash: storedEventHash({ seq, prevHash, signed }),
    };
    this.events.push(stored);
    return stored;
  }
}

/** TRIP_CREATED, RATE_SET, the three travelers joined, admitted and with channels, all at T0. */
export function tripLog(): Log {
  const log = new Log();
  log.push(
    'TRIP_CREATED',
    KEY.dave,
    {
      name: 'Vietnam 2026',
      assetId: 'rgb:dusd',
      params: DEMO_TRIP_PARAMS,
      coordinatorPubkey: KEY.dave,
    },
    0,
  );
  log.push(
    'RATE_SET',
    KEY.dave,
    { asOf: '2026-10-17', source: 'infra/rates.json', rates: { VND: '26350' } },
    0,
  );
  for (const id of ['alice', 'bob', 'charlie'] as const satisfies readonly MemberId[]) {
    log.push(
      'MEMBER_JOINED',
      KEY[id],
      {
        displayName: id,
        memberId: id,
        appPubkey: KEY[id],
        nodePubkey: NODE(KEY[id]),
        bindInvoice: `lnbcrt1bind${id}`,
        policy: DEFAULT_POLICY,
      },
      0,
    );
    log.push('MEMBER_ADMITTED', KEY.dave, { memberPubkey: KEY[id] }, 0);
    log.push(
      'CHANNELS_READY',
      KEY.dave,
      { memberPubkey: KEY[id], tripChannelId: `trip-${id}`, liquidityChannelId: `liq-${id}` },
      0,
    );
  }
  return log;
}

export interface ExpenseSpec {
  payer: string;
  receipt: Receipt;
  payerItemIndexes: number[];
  debtors: { id: string; itemIndexes: number[] }[];
  expenseId?: string;
  fingerprint?: string;
  /** Units of the receipt currency per 1 USD; default the demo VND rate. */
  rate?: string;
}

/** An EXPENSE_SUBMITTED with the shares computed by the ledger. */
export function submit(log: Log, spec: ExpenseSpec, s: number): StoredEvent {
  const rateEvent = log.events.find((e) => e.signed.inner.type === 'RATE_SET');
  const rate = spec.rate ?? '26350';
  const shares = expenseShares({
    receipt: spec.receipt,
    rate,
    payer: spec.payer,
    payerItemIndexes: spec.payerItemIndexes,
    debtors: spec.debtors,
  });
  const expenseId = spec.expenseId ?? 'dinner';
  return log.push(
    'EXPENSE_SUBMITTED',
    spec.payer,
    {
      expenseId,
      receipt: spec.receipt,
      receiptImageSha256: hex('f'),
      rateEventHash: rateEvent?.hash ?? hex('9'),
      rate,
      totalUsdCents: shares.totalUsdCents,
      payerCents: shares.payerCents,
      payerItemIndexes: spec.payerItemIndexes,
      lines: spec.debtors.map((d, i) => ({
        debtorPubkey: d.id,
        cents: shares.debtors[i]?.cents ?? 0n,
        itemIndexes: d.itemIndexes,
        bolt11: `lnbcrt1${expenseId}${i}`,
      })),
      fingerprint: spec.fingerprint ?? hex('8'),
    },
    s,
  );
}

/** The demo dinner (SPEC §15): alice pays; bob shares pho + water, charlie beers + water. */
export const dinnerSpec: ExpenseSpec = {
  payer: KEY.alice,
  receipt: dinner,
  payerItemIndexes: [0, 2],
  debtors: [
    { id: KEY.bob, itemIndexes: [0, 2] },
    { id: KEY.charlie, itemIndexes: [1, 2] },
  ],
};
