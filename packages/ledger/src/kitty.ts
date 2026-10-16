import type {
  AutoPayDecision,
  DecodedInvoice,
  EventBody,
  LineState,
  MemberId,
  Policy,
  Pubkey,
  SignatureVerifier,
  StoredEvent,
  TripParams,
} from '@kitty/shared';
import { LedgerError } from './errors.js';

// The rules of kit+ty as pure functions (CLAUDE.md rule 5): no I/O, clock and crypto injected.
// Relay and agents call them; nobody re-implements them. Bodies: tasks A1, A2, A3, A7.
// The shapes below are the contract; A may add fields, never change the meaning of one.

/** A member as derived from the log. Keys are author pubkeys (appPubkey with rln-rest). */
export interface MemberState {
  memberId: MemberId;
  displayName: string;
  pubkey: Pubkey;
  /** Node key bound by the MEMBER_JOINED bind invoice; the payee of their invoices. */
  nodePubkey: string;
  policy: Policy;
  admitted: boolean;
  channelsReady: boolean;
  excluded: boolean;
  closingTxids: readonly string[];
  /** Σ GUARANTEE_PAID for this member as debtor, against params.guaranteeCapCents. */
  guaranteeUsedCents: bigint;
}

/** One line = (expense, debtor), SPEC §7. */
export interface LineRecord {
  expenseEventHash: string;
  expenseId: string;
  payerPubkey: Pubkey;
  debtorPubkey: Pubkey;
  cents: bigint;
  itemIndexes: readonly number[];
  /** The current invoice (INVOICE_REISSUED replaces it). */
  bolt11: string;
  state: LineState;
  seenAt: Date | null;
  /** The deadline of the current state, or null (see LineView.deadlineAt). */
  deadlineAt: Date | null;
  contestReason: string | null;
  resolution: EventBody<'DISPUTE_RESOLVED'>['outcome'] | null;
  /** Debtor's explicit approval (vs silent assent), for decideAutoPay. */
  approvedExplicitly: boolean;
  payment:
    | { by: 'debtor'; rail: 'ln'; paymentHash: string; preimage: string; at: Date }
    | { by: 'debtor'; rail: 'onchain'; txid: string; at: Date }
    | { by: 'guarantee'; paymentHash: string; preimage: string; at: Date }
    | null;
}

export interface ExpenseRecord {
  eventHash: string;
  seq: number;
  payerPubkey: Pubkey;
  submittedAt: Date;
  body: EventBody<'EXPENSE_SUBMITTED'>;
  voided: boolean;
}

/** Everything derived from the log at time `now`. Never stored, always recomputed. */
export interface TripState {
  tripId: string;
  name: string;
  assetId: string;
  params: TripParams;
  coordinatorPubkey: Pubkey;
  closed: boolean;
  /** The latest RATE_SET and its StoredEvent hash. */
  rate: { eventHash: string; body: EventBody<'RATE_SET'> } | null;
  members: ReadonlyMap<Pubkey, MemberState>;
  expenses: ReadonlyMap<string, ExpenseRecord>;
  /** Keyed by `${expenseEventHash}:${debtorPubkey}`. */
  lines: ReadonlyMap<string, LineRecord>;
  /** Payments made automatically, for the 24 h cap: debtor pubkey → [{ at, cents }]. */
  autoPayments: ReadonlyMap<Pubkey, readonly { at: Date; cents: bigint }[]>;
  noncesSeen: ReadonlySet<string>;
  fingerprints: ReadonlySet<string>;
  head: { seq: number; hash: string } | null;
}

export function lineKey(expenseEventHash: string, debtorPubkey: string): string {
  return `${expenseEventHash}:${debtorPubkey}`;
}

/**
 * Folds the log into the trip state at `now` (task A1). SPEC §7: line states are derived,
 * never stored; silent assent runs from LINE_SEEN (seenAt + silentAssentSeconds), only within
 * the debtor's policy (SPEC §6.4, §8); unpaid past seenAt + paymentDeadlineSeconds → overdue;
 * an excluded member's open lines are overdue at once (SPEC §6.7); upheld disputes get a new
 * deadline (SPEC §6.6). Events must already be validated and in seq order.
 */
export function deriveTrip(events: readonly StoredEvent[], now: Date): TripState {
  void events;
  void now;
  throw new LedgerError('NOT_IMPLEMENTED', 'deriveTrip: task A1');
}

/** What validateEvent needs from outside, injected so the ledger stays pure (SPEC §9.3). */
export interface ValidationDeps {
  verify: SignatureVerifier;
  /** A JS BOLT11 decoder on the relay; the agent may also use its node's /decodelninvoice. */
  decodeInvoice: (bolt11: string) => DecodedInvoice;
}

export type ValidationResult = { ok: true } | { ok: false; code: 'INVALID_EVENT'; reason: string };

/**
 * Checks one event against the trip derived from all the previous ones (task A2, SPEC §9.3):
 * signature of `author` over signingMessage(inner); author admitted (except TRIP_CREATED and
 * MEMBER_JOINED), coordinator types only from dave (EVENT_AUTHOR); nonce never seen; chain
 * (seq = head + 1, prevHash = head hash, hash = storedEventHash); EXPENSE_SUBMITTED totals
 * (items + tax + tip = total; Σ lines + payerCents = totalUsdCents; shares recomputed from the
 * receipt, itemIndexes, payerItemIndexes and rate), active debtors, fresh fingerprint, each
 * invoice decodable, payee = payer's node, trip asset and line amount; LINE_SEEN/LINE_DECIDED
 * by a debtor of that expense with matching cents; PAYMENT_MADE/GUARANTEE_PAID with
 * sha256(preimage) = the invoice payment hash and matching amount; MEMBER_JOINED bind invoice
 * from nodePubkey with description `kitty-bind:<sha256(appPubkey)>` (SPEC §9.1).
 * `trip` is null before TRIP_CREATED.
 */
export function validateEvent(
  stored: StoredEvent,
  trip: TripState | null,
  deps: ValidationDeps,
): ValidationResult {
  void stored;
  void trip;
  void deps;
  throw new LedgerError('NOT_IMPLEMENTED', 'validateEvent: task A2');
}

/**
 * Whether the debtor's agent pays this line now, and the sentence that says why (task A3,
 * SPEC §8). Pays only if: the line is `due`; the expense is verified; the invoice payee is the
 * creditor's registered node and amount and asset match the line; within dailyCapCents for
 * automatic payments; a line upheld after a contest only with payUpheldDisputes. Never pays
 * contested or unverified lines, mismatched totals, or on a closed trip.
 * E.g. "Paid 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00".
 */
export function decideAutoPay(
  policy: Policy,
  line: LineRecord,
  trip: TripState,
  now: Date,
): AutoPayDecision {
  void policy;
  void line;
  void trip;
  void now;
  throw new LedgerError('NOT_IMPLEMENTED', 'decideAutoPay: task A3');
}

export interface LiquidityNeed {
  memberPubkey: Pubkey;
  /** L(m) + sent(m) − received(m); guarantee payments count as received. */
  inboundCents: bigint;
  /** Σ open lines (not paid, not voided) in favour of m. */
  toReceiveCents: bigint;
  /** inbound − toReceive. */
  marginCents: bigint;
  /** A new liquidity channel to open now, or 0n: toReceive − margin + threshold if margin < threshold. */
  openCents: bigint;
}

/**
 * dave's just-in-time liquidity (task A7, SPEC §10.5), per active member. Excluded members
 * have no channels and need none.
 */
export function liquidityPlan(trip: TripState, thresholdCents: bigint): LiquidityNeed[] {
  void trip;
  void thresholdCents;
  throw new LedgerError('NOT_IMPLEMENTED', 'liquidityPlan: task A7');
}
