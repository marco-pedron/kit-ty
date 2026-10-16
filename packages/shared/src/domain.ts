import { z } from 'zod';
import {
  Bolt11Schema,
  HashHexSchema,
  MemberIdSchema,
  NodePubkeySchema,
  PreimageHexSchema,
  TxidSchema,
} from './ids.js';
import { CurrencyCodeSchema, minorString, positiveMinorString } from './money.js';

// Domain schemas shared by ledger, agent, relay and UI. Amounts use the money codec:
// bigint after z.decode, decimal strings of minor units after z.encode.

// ---------- AI (SPEC §11) ----------

// Amounts in minor units of the receipt currency (VND exponent 0, EUR/USD cents).
// `quantity` is a whole number: receipts end up in signed events, whose canonical JSON
// accepts integers only. A fractional quantity from the model fails this schema and takes
// the normal path (retry with the error, then the pre-filled manual form), never a crash.
export const ReceiptItemSchema = z.object({
  label: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: minorString,
  total: minorString,
});
export type ReceiptItem = z.output<typeof ReceiptItemSchema>;

export const ReceiptSchema = z.object({
  merchant: z.string(),
  date: z.iso.date(),
  currency: CurrencyCodeSchema,
  items: z.array(ReceiptItemSchema).min(1),
  subtotal: minorString.optional(),
  tax: minorString.optional(),
  tip: minorString.optional(),
  total: positiveMinorString,
  // Inconsistencies found by the deterministic checks after zod: shown, never silently fixed.
  warnings: z.array(z.string()),
});
export type Receipt = z.output<typeof ReceiptSchema>;

// Active travelers only: never dave, never excluded members. Indexes are checked against
// the receipt by the AI layer (out of range → retry → manual form).
export const SplitAssignmentSchema = z.object({
  itemIndex: z.number().int().nonnegative(),
  members: z.array(MemberIdSchema).min(1),
});
export type SplitAssignment = z.output<typeof SplitAssignmentSchema>;

export const SplitProposalSchema = z.object({
  assignments: z.array(SplitAssignmentSchema),
  unassigned: z.array(z.number().int().nonnegative()),
  clarificationNeeded: z.string().min(1).optional(),
});
export type SplitProposal = z.output<typeof SplitProposalSchema>;

/** `{ ok: true, data } | { ok: false, partial, error }` for any AI task (SPEC §11). */
export function aiResult<D extends z.ZodType, P extends z.ZodType>(data: D, partial: P) {
  return z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      data,
      attempts: z.number().int().min(1),
      latencyMs: z.number().int().nonnegative(),
    }),
    z.object({
      ok: z.literal(false),
      // Whatever was parsed, to pre-fill the manual form.
      partial,
      error: z.string(),
      attempts: z.number().int().nonnegative(),
      latencyMs: z.number().int().nonnegative(),
    }),
  ]);
}
export type AiResult<T, P = Partial<T>> =
  | { ok: true; data: T; attempts: number; latencyMs: number }
  | { ok: false; partial: P; error: string; attempts: number; latencyMs: number };

export const ReceiptResultSchema = aiResult(ReceiptSchema, ReceiptSchema.partial());
export const SplitResultSchema = aiResult(SplitProposalSchema, SplitProposalSchema.partial());

export const AiStatusSchema = z.object({
  status: z.enum(['loading', 'ready', 'error']),
  error: z.string().optional(),
  /** true with KITTY_FAKES=1: the UI must not claim on-device AI. */
  fake: z.boolean(),
});
export type AiStatus = z.infer<typeof AiStatusSchema>;

// ---------- agent policy (SPEC §8) ----------

export const PolicySchema = z.object({
  /** Above this per line, no silent assent. */
  autoPayLimitCents: minorString,
  /** Max paid automatically in 24 hours. */
  dailyCapCents: minorString,
  /** Pay on its own the lines contested and then upheld by dave. */
  payUpheldDisputes: z.boolean(),
});
export type Policy = z.output<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  autoPayLimitCents: 2000n,
  dailyCapCents: 6000n,
  payUpheldDisputes: false,
};

/** Output of decideAutoPay: `reason` is the sentence shown to the user (SPEC §8). */
export const AutoPayDecisionSchema = z.object({ pay: z.boolean(), reason: z.string() });
export type AutoPayDecision = z.infer<typeof AutoPayDecisionSchema>;

// ---------- trip parameters (SPEC §10.4, §15) ----------

export const RailModeSchema = z.enum(['ln-2ch', 'ln-lsp', 'onchain']);
export type RailMode = z.infer<typeof RailModeSchema>;

export const TripParamsSchema = z.object({
  railMode: RailModeSchema,
  /** D: DUSD each traveler locks in the trip channel. */
  tripChannelCents: positiveMinorString,
  /** L: dave's initial liquidity per traveler. */
  liquidityCents: positiveMinorString,
  /** G: operator guarantee per member and trip. */
  guaranteeCapCents: minorString,
  /** BTC capacity of each channel, in sat. */
  channelCapacitySat: positiveMinorString,
  silentAssentSeconds: z.number().int().positive(),
  paymentDeadlineSeconds: z.number().int().positive(),
  invoiceExpirySeconds: z.number().int().positive(),
  /** Warn when the trip channel falls below this percent of D (SPEC §6.9). */
  topupWarnPercent: z.number().int().min(0).max(100),
});
export type TripParams = z.output<typeof TripParamsSchema>;

export const DEMO_TRIP_PARAMS: TripParams = {
  railMode: 'ln-2ch',
  tripChannelCents: 5000n,
  liquidityCents: 3000n,
  guaranteeCapCents: 5000n,
  channelCapacitySat: 1_000_000n,
  silentAssentSeconds: 20,
  paymentDeadlineSeconds: 30,
  invoiceExpirySeconds: 3600,
  topupWarnPercent: 20,
};

// ---------- lines (SPEC §7) ----------

/** One line = (expense, debtor). Always derived from events by deriveTrip, never stored. */
export const LineStateSchema = z.enum([
  'submitted',
  'awaiting_decision',
  'awaiting_explicit',
  'contested',
  'due',
  'overdue',
  'paid',
  'guaranteed',
  'voided',
]);
export type LineState = z.infer<typeof LineStateSchema>;
export const FINAL_LINE_STATES: readonly LineState[] = ['paid', 'guaranteed', 'voided'];

// ---------- payments (SPEC §10) ----------

/** What a rail returns after paying; `sha256(preimage) == paymentHash` (SPEC §10.2). */
export const PaymentProofSchema = z.discriminatedUnion('rail', [
  z.object({
    rail: z.literal('ln'),
    paymentHash: HashHexSchema,
    preimage: PreimageHexSchema,
    cents: positiveMinorString,
    /** Node key of the creditor, from the invoice. */
    payeePubkey: NodePubkeySchema,
  }),
  z.object({
    rail: z.literal('onchain'),
    txid: TxidSchema,
    cents: positiveMinorString,
  }),
]);
export type PaymentProof = z.output<typeof PaymentProofSchema>;

/** Wallet.decodeInvoice, from RLN /decodelninvoice (docs/spike-lightning.md, Q5). */
export const DecodedInvoiceSchema = z.object({
  bolt11: Bolt11Schema,
  payeePubkey: NodePubkeySchema,
  paymentHash: HashHexSchema,
  /** RGB asset of the invoice; null for a plain BTC invoice (never valid in a trip). */
  assetId: z.string().nullable(),
  /** asset_amount, in DUSD cents; null if the invoice does not fix it. */
  cents: minorString.nullable(),
  /** BTC that travels with the HTLC (≥ rgb_htlc_min_msat, SPEC §10.1). */
  amtMsat: minorString.nullable(),
  description: z.string(),
  /** timestamp + expiry_sec. */
  expiresAt: z.iso.datetime(),
});
export type DecodedInvoice = z.output<typeof DecodedInvoiceSchema>;
