import { z } from 'zod';
import { canonicalHash, canonicalize } from './canonical.js';
import {
  AppPubkeySchema,
  Bolt11Schema,
  ExpenseIdSchema,
  HashHexSchema,
  MemberIdSchema,
  NodePubkeySchema,
  NonceHexSchema,
  PreimageHexSchema,
  PubkeySchema,
  TripIdSchema,
  TxidSchema,
} from './ids.js';
import {
  DecimalStringSchema,
  CurrencyCodeSchema,
  minorString,
  positiveMinorString,
} from './money.js';
import { PolicySchema, ReceiptSchema, TripParamsSchema } from './domain.js';

// The signed log (SPEC §9). The author signs canonical(inner); the relay wraps it in a
// StoredEvent and chains it. Every event that refers to an expense carries the `hash` of the
// StoredEvent of its EXPENSE_SUBMITTED (`expenseEventHash`): that, the trip id, the nonce and
// the amounts make a signature useless in any other context (anti-replay, SPEC §9.1).
//
// Pubkeys in bodies (`debtorPubkey`, `creditorPubkey`, `memberPubkey`, `coordinatorPubkey`)
// are author identities (the appPubkey with rln-rest). Node keys appear only as `nodePubkey`
// in MEMBER_JOINED and as the payee of invoices.

// ---------- bodies (SPEC §9.2) ----------

const RefExpense = z.object({ expenseEventHash: HashHexSchema });

export const TripCreatedBodySchema = z.object({
  name: z.string().min(1),
  /** RGB asset id of DUSD (NIA, precision 2). */
  assetId: z.string().min(1),
  params: TripParamsSchema,
  coordinatorPubkey: PubkeySchema,
});

export const RateSetBodySchema = z.object({
  asOf: z.iso.date(),
  source: z.string().min(1),
  /** Units of each currency per 1 USD, as decimal strings. */
  rates: z.partialRecord(CurrencyCodeSchema, DecimalStringSchema),
});

export const MemberJoinedBodySchema = z.object({
  displayName: z.string().min(1),
  memberId: MemberIdSchema,
  appPubkey: AppPubkeySchema,
  nodePubkey: NodePubkeySchema,
  /**
   * rln-rest: invoice from the member's own node with description `kitty-bind:<sha256(appPubkey)>`;
   * its payee_pubkey must equal nodePubkey (SPEC §9.1). null only with the wdk engine.
   */
  bindInvoice: Bolt11Schema.nullable(),
  policy: PolicySchema,
});

export const MemberAdmittedBodySchema = z.object({ memberPubkey: PubkeySchema });

export const PolicyUpdatedBodySchema = z.object({ policy: PolicySchema });

export const ChannelsReadyBodySchema = z.object({
  memberPubkey: PubkeySchema,
  tripChannelId: z.string().min(1),
  liquidityChannelId: z.string().min(1),
});

export const ExpenseLineSchema = z.object({
  debtorPubkey: PubkeySchema,
  cents: positiveMinorString,
  /** Receipt items this debtor shares. */
  itemIndexes: z.array(z.number().int().nonnegative()).min(1),
  /** Created by the payer's node: `kitty:<tripId>:<expenseId>:<debtor memberId>`. */
  bolt11: Bolt11Schema,
});
export type ExpenseLine = z.output<typeof ExpenseLineSchema>;

export const ExpenseSubmittedBodySchema = z.object({
  expenseId: ExpenseIdSchema,
  receipt: ReceiptSchema,
  /** The photo stays on the payer's phone; only its hash is committed. */
  receiptImageSha256: HashHexSchema,
  /** StoredEvent.hash of the RATE_SET used, locked at submission. */
  rateEventHash: HashHexSchema,
  /** Units of the receipt currency per 1 USD, copied from that RATE_SET. */
  rate: DecimalStringSchema,
  totalUsdCents: positiveMinorString,
  /** The payer's own share: Σ lines.cents + payerCents = totalUsdCents (SPEC §9.3). */
  payerCents: minorString,
  /** Items the payer shares, so validators can recompute the split from the receipt. */
  payerItemIndexes: z.array(z.number().int().nonnegative()),
  lines: z.array(ExpenseLineSchema).min(1),
  /** sha256(canonical({ merchant, date, currency, total, receiptImageSha256 })), SPEC §13 #5. */
  fingerprint: HashHexSchema,
});

export const LineSeenBodySchema = RefExpense;

export const LineDecidedBodySchema = RefExpense.extend({
  decision: z.enum(['approve', 'contest']),
  cents: positiveMinorString,
  reason: z.string().min(1).optional(),
});

const PaymentCommon = RefExpense.extend({
  creditorPubkey: PubkeySchema,
  cents: positiveMinorString,
});
export const PaymentMadeBodySchema = z.discriminatedUnion('rail', [
  PaymentCommon.extend({
    rail: z.literal('ln'),
    paymentHash: HashHexSchema,
    preimage: PreimageHexSchema,
  }),
  PaymentCommon.extend({ rail: z.literal('onchain'), txid: TxidSchema }),
]);

export const ExpenseVoidedBodySchema = RefExpense;

export const DisputeResolvedBodySchema = RefExpense.extend({
  debtorPubkey: PubkeySchema,
  outcome: z.enum(['upheld', 'line_voided', 'expense_voided']),
  note: z.string(),
});

export const InvoiceReissuedBodySchema = RefExpense.extend({
  debtorPubkey: PubkeySchema,
  bolt11: Bolt11Schema,
});

export const GuaranteePaidBodySchema = RefExpense.extend({
  debtorPubkey: PubkeySchema,
  creditorPubkey: PubkeySchema,
  cents: positiveMinorString,
  paymentHash: HashHexSchema,
  preimage: PreimageHexSchema,
});

export const MemberExcludedBodySchema = z.object({
  memberPubkey: PubkeySchema,
  reason: z.string().min(1),
  closingTxids: z.array(TxidSchema),
});

export const CheckpointBodySchema = z.object({
  seq: z.number().int().positive(),
  headHash: HashHexSchema,
});

export const TripClosedBodySchema = z.object({ summary: z.string() });

// ---------- inner, signed, stored (SPEC §9.1) ----------

const bodies = {
  TRIP_CREATED: TripCreatedBodySchema,
  RATE_SET: RateSetBodySchema,
  MEMBER_JOINED: MemberJoinedBodySchema,
  MEMBER_ADMITTED: MemberAdmittedBodySchema,
  POLICY_UPDATED: PolicyUpdatedBodySchema,
  CHANNELS_READY: ChannelsReadyBodySchema,
  EXPENSE_SUBMITTED: ExpenseSubmittedBodySchema,
  LINE_SEEN: LineSeenBodySchema,
  LINE_DECIDED: LineDecidedBodySchema,
  PAYMENT_MADE: PaymentMadeBodySchema,
  EXPENSE_VOIDED: ExpenseVoidedBodySchema,
  DISPUTE_RESOLVED: DisputeResolvedBodySchema,
  INVOICE_REISSUED: InvoiceReissuedBodySchema,
  GUARANTEE_PAID: GuaranteePaidBodySchema,
  MEMBER_EXCLUDED: MemberExcludedBodySchema,
  CHECKPOINT: CheckpointBodySchema,
  TRIP_CLOSED: TripClosedBodySchema,
} as const;

export type EventType = keyof typeof bodies;
export const EVENT_TYPES = Object.keys(bodies) as [EventType, ...EventType[]];
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventBody<T extends EventType> = z.output<(typeof bodies)[T]>;

/** Who may author each type (SPEC §9.2). Enforced by validateEvent, here as data. */
export const EVENT_AUTHOR: Record<
  EventType,
  'coordinator' | 'member' | 'debtor' | 'payer' | 'any'
> = {
  TRIP_CREATED: 'coordinator',
  RATE_SET: 'coordinator',
  MEMBER_JOINED: 'member',
  MEMBER_ADMITTED: 'coordinator',
  POLICY_UPDATED: 'member',
  CHANNELS_READY: 'coordinator',
  EXPENSE_SUBMITTED: 'payer',
  LINE_SEEN: 'debtor',
  LINE_DECIDED: 'debtor',
  PAYMENT_MADE: 'debtor',
  EXPENSE_VOIDED: 'payer',
  DISPUTE_RESOLVED: 'coordinator',
  INVOICE_REISSUED: 'payer',
  GUARANTEE_PAID: 'coordinator',
  MEMBER_EXCLUDED: 'coordinator',
  CHECKPOINT: 'any',
  TRIP_CLOSED: 'coordinator',
};

const envelope = {
  v: z.literal(1),
  tripId: TripIdSchema,
  author: PubkeySchema,
  nonce: NonceHexSchema,
  createdAt: z.iso.datetime(),
};

function innerOf<T extends EventType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), body: bodies[type] });
}

export const EventInnerSchema = z.discriminatedUnion('type', [
  innerOf('TRIP_CREATED'),
  innerOf('RATE_SET'),
  innerOf('MEMBER_JOINED'),
  innerOf('MEMBER_ADMITTED'),
  innerOf('POLICY_UPDATED'),
  innerOf('CHANNELS_READY'),
  innerOf('EXPENSE_SUBMITTED'),
  innerOf('LINE_SEEN'),
  innerOf('LINE_DECIDED'),
  innerOf('PAYMENT_MADE'),
  innerOf('EXPENSE_VOIDED'),
  innerOf('DISPUTE_RESOLVED'),
  innerOf('INVOICE_REISSUED'),
  innerOf('GUARANTEE_PAID'),
  innerOf('MEMBER_EXCLUDED'),
  innerOf('CHECKPOINT'),
  innerOf('TRIP_CLOSED'),
]);
export type EventInner = z.output<typeof EventInnerSchema>;
export type EventInnerOf<T extends EventType> = Extract<EventInner, { type: T }>;

/** Written by the author. `sig` format depends on the wallet engine (SPEC §9.1, crypto.ts). */
export const SignedEventSchema = z.object({
  inner: EventInnerSchema,
  sig: z.string().min(1),
});
export type SignedEvent = z.output<typeof SignedEventSchema>;

/** prevHash of the first event (seq 1). */
export const GENESIS_HASH = '0'.repeat(64);

/** Written by the relay. hash = sha256(canonical({ seq, prevHash, signed })). */
export const StoredEventSchema = z.object({
  seq: z.number().int().positive(),
  prevHash: HashHexSchema,
  signed: SignedEventSchema,
  receivedAt: z.iso.datetime(),
  hash: HashHexSchema,
});
export type StoredEvent = z.output<typeof StoredEventSchema>;

/** The exact string the author signs: canonical JSON of the encoded inner. */
export function signingMessage(inner: EventInner): string {
  return canonicalize(z.encode(EventInnerSchema, inner));
}

/** The relay's chain hash of a stored event; anyone recomputes it to check the chain. */
export function storedEventHash(e: Pick<StoredEvent, 'seq' | 'prevHash' | 'signed'>): string {
  return canonicalHash({
    seq: e.seq,
    prevHash: e.prevHash,
    signed: z.encode(SignedEventSchema, e.signed),
  });
}
