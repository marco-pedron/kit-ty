import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  GENESIS_HASH,
  sha256Hex,
  signingMessage,
  storedEventHash,
  type DecodedInvoice,
  type EventBody,
  type EventInner,
  type EventType,
  type MemberId,
  type Receipt,
  type SignatureVerifier,
  type StoredEvent,
  type TripParams,
} from '@kitty/shared';
import {
  deriveTrip,
  expenseFingerprint,
  expenseShares,
  hexToBytes,
  validateEvent,
  type ValidationDeps,
  type ValidationResult,
} from '../src/index.js';

// Builders for a signed log with a real hash chain, test signatures that a test verifier
// checks, and invoices that a fake decoder resolves (so the ledger tests need no node, no B4).

export const KEY = {
  alice: 'a'.repeat(64),
  bob: 'b'.repeat(64),
  charlie: 'c'.repeat(64),
  dave: 'd'.repeat(64),
} as const;
export const NODE = (k: string) => `02${k}`;
export const MEMBER_OF: Record<string, MemberId> = {
  [KEY.alice]: 'alice',
  [KEY.bob]: 'bob',
  [KEY.charlie]: 'charlie',
};
export const TRIP_ID = 'vietnam-2026';
export const ASSET_ID = 'rgb:dusd';
export const T0 = Date.parse('2026-10-17T12:00:00.000Z');
/** The instant `s` seconds after T0. */
export const at = (s: number) => new Date(T0 + s * 1000);
export const hex = (c: string) => c.repeat(64).slice(0, 64);

/** A test signature: anyone can forge it, which is fine in a test. */
export const testSign = (author: string, message: string) => `test:${author}:${sha256Hex(message)}`;
export const testVerifier: SignatureVerifier = {
  verify: (author, message, sig) => sig === testSign(author, message),
};

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

export interface InvoiceSpec {
  payee: string;
  cents: bigint | null;
  description: string;
  /** Seconds after T0. */
  expiresAtS: number;
  assetId?: string | null;
}

// Unique across logs, so events copied from one log into another never collide.
let nonceCount = 0;

export class Log {
  readonly events: StoredEvent[] = [];
  readonly invoices = new Map<string, DecodedInvoice>();
  readonly preimages = new Map<string, string>();
  private invoiceCount = 0;

  readonly deps: ValidationDeps = {
    verify: testVerifier,
    decodeInvoice: (bolt11) => {
      const inv = this.invoices.get(bolt11);
      if (inv === undefined) throw new Error('unknown invoice');
      return inv;
    },
  };

  /** A decodable invoice with a real preimage; returns its bolt11. */
  invoice(spec: InvoiceSpec): string {
    const n = this.invoiceCount++;
    const bolt11 = `lnbcrt1inv${n}`;
    const preimage = sha256Hex(`preimage ${n}`);
    const paymentHash = sha256Hex(hexToBytes(preimage));
    this.preimages.set(bolt11, preimage);
    this.invoices.set(bolt11, {
      bolt11,
      payeePubkey: spec.payee,
      paymentHash,
      assetId: spec.assetId === undefined ? ASSET_ID : spec.assetId,
      cents: spec.cents,
      amtMsat: 3_000_000n,
      description: spec.description,
      expiresAt: at(spec.expiresAtS).toISOString(),
    });
    return bolt11;
  }

  /** paymentHash and preimage of an invoice made by `invoice()`. */
  proof(bolt11: string): { paymentHash: string; preimage: string } {
    const inv = this.invoices.get(bolt11);
    const preimage = this.preimages.get(bolt11);
    if (inv === undefined || preimage === undefined) throw new Error('unknown invoice');
    return { paymentHash: inv.paymentHash, preimage };
  }

  /** The next event, chained and signed, without appending it. */
  build<T extends EventType>(type: T, author: string, body: EventBody<T>, s: number): StoredEvent {
    const inner = {
      v: 1,
      tripId: TRIP_ID,
      type,
      author,
      nonce: (nonceCount++).toString(16).padStart(32, '0'),
      createdAt: at(s).toISOString(),
      body,
    } as EventInner;
    const seq = this.events.length + 1;
    const prevHash = this.events.at(-1)?.hash ?? GENESIS_HASH;
    const signed = { inner, sig: testSign(author, signingMessage(inner)) };
    return {
      seq,
      prevHash,
      signed,
      receivedAt: at(s).toISOString(),
      hash: storedEventHash({ seq, prevHash, signed }),
    };
  }

  push<T extends EventType>(type: T, author: string, body: EventBody<T>, s: number): StoredEvent {
    const stored = this.build(type, author, body, s);
    this.events.push(stored);
    return stored;
  }

  /** validateEvent of `stored` against the whole log, as the relay would call it. */
  check(stored: StoredEvent): ValidationResult {
    const trip = deriveTrip(this.events, new Date(stored.receivedAt));
    return validateEvent(stored, trip, this.deps);
  }

  /** Every event validated against the ones before it. */
  checkAll(): ValidationResult[] {
    return this.events.map((e, i) =>
      validateEvent(e, deriveTrip(this.events.slice(0, i), new Date(e.receivedAt)), this.deps),
    );
  }
}

/** Re-sign an event after tampering with its inner, and re-hash it (still on the same chain). */
export function resign(e: StoredEvent, inner: EventInner): StoredEvent {
  const signed = { inner, sig: testSign(inner.author, signingMessage(inner)) };
  return { ...e, signed, hash: storedEventHash({ seq: e.seq, prevHash: e.prevHash, signed }) };
}

export function joinBody(log: Log, id: MemberId): EventBody<'MEMBER_JOINED'> {
  return {
    displayName: id,
    memberId: id,
    appPubkey: KEY[id],
    nodePubkey: NODE(KEY[id]),
    bindInvoice: log.invoice({
      payee: NODE(KEY[id]),
      cents: null,
      assetId: null,
      description: `kitty-bind:${sha256Hex(KEY[id])}`,
      expiresAtS: 3600,
    }),
    policy: DEFAULT_POLICY,
  };
}

/** TRIP_CREATED, RATE_SET, the three travelers joined, admitted and with channels, all at T0. */
export function tripLog(params: TripParams = DEMO_TRIP_PARAMS): Log {
  const log = new Log();
  log.push(
    'TRIP_CREATED',
    KEY.dave,
    {
      name: 'Vietnam 2026',
      assetId: ASSET_ID,
      params,
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
  for (const id of ['alice', 'bob', 'charlie'] as const) {
    log.push('MEMBER_JOINED', KEY[id], joinBody(log, id), 0);
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
  /** Default: a different photo hash per expense id. */
  receiptImageSha256?: string;
  /** Units of the receipt currency per 1 USD; default the demo VND rate. */
  rate?: string;
}

/** A valid EXPENSE_SUBMITTED body: shares, fingerprint and invoices as the payer's agent makes them. */
export function expenseBody(
  log: Log,
  spec: ExpenseSpec,
  s: number,
): EventBody<'EXPENSE_SUBMITTED'> {
  const rateEvent = log.events.findLast((e) => e.signed.inner.type === 'RATE_SET');
  const rate = spec.rate ?? '26350';
  const expenseId = spec.expenseId ?? 'dinner';
  const receiptImageSha256 = spec.receiptImageSha256 ?? sha256Hex(`photo ${expenseId}`);
  const shares = expenseShares({
    receipt: spec.receipt,
    rate,
    payer: spec.payer,
    payerItemIndexes: spec.payerItemIndexes,
    debtors: spec.debtors,
  });
  return {
    expenseId,
    receipt: spec.receipt,
    receiptImageSha256,
    rateEventHash: rateEvent?.hash ?? hex('9'),
    rate,
    totalUsdCents: shares.totalUsdCents,
    payerCents: shares.payerCents,
    payerItemIndexes: spec.payerItemIndexes,
    lines: spec.debtors.map((d, i) => {
      const cents = shares.debtors[i]?.cents ?? 0n;
      return {
        debtorPubkey: d.id,
        cents,
        itemIndexes: d.itemIndexes,
        bolt11: log.invoice({
          payee: NODE(spec.payer),
          cents,
          description: `kitty:${TRIP_ID}:${expenseId}:${MEMBER_OF[d.id] ?? 'unknown'}`,
          expiresAtS: s + DEMO_TRIP_PARAMS.invoiceExpirySeconds,
        }),
      };
    }),
    fingerprint: expenseFingerprint(spec.receipt, receiptImageSha256),
  };
}

/** Appends a valid EXPENSE_SUBMITTED. */
export function submit(log: Log, spec: ExpenseSpec, s: number): StoredEvent {
  return log.push('EXPENSE_SUBMITTED', spec.payer, expenseBody(log, spec, s), s);
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
