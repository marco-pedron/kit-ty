import type {
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
import { FINAL_LINE_STATES } from '@kitty/shared';
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
  /** Σ open lines (not paid, guaranteed or voided) where this member is the debtor. */
  oweCents: bigint;
  /** Σ open lines where this member is the payer. */
  owedToMeCents: bigint;
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
  /**
   * When an unpaid awaiting_explicit/due line becomes overdue: seenAt + paymentDeadlineSeconds,
   * or resolvedAt + paymentDeadlineSeconds after an upheld dispute. null before LINE_SEEN.
   */
  paymentDeadlineAt: Date | null;
  /** When the line became overdue (the deadline, or the exclusion); kept after it is settled. */
  overdueAt: Date | null;
  contestReason: string | null;
  contestedAt: Date | null;
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
  /** Overdue lines, for dave's "Copri ed escludi": oldest overdueAt first. */
  defaults: readonly LineRecord[];
  /** Payments made automatically, for the 24 h cap: debtor pubkey → [{ at, cents }]. */
  autoPayments: ReadonlyMap<Pubkey, readonly { at: Date; cents: bigint }[]>;
  noncesSeen: ReadonlySet<string>;
  /** Fingerprints of the expenses not voided: a voided expense can be submitted again. */
  fingerprints: ReadonlySet<string>;
  head: { seq: number; hash: string } | null;
}

export function lineKey(expenseEventHash: string, debtorPubkey: string): string {
  return `${expenseEventHash}:${debtorPubkey}`;
}

const isFinal = (l: LineRecord) => FINAL_LINE_STATES.includes(l.state);
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/**
 * Folds the log into the trip state at `now` (task A1). SPEC §7: line states are derived,
 * never stored; silent assent runs from LINE_SEEN (seenAt + silentAssentSeconds), only within
 * the debtor's policy (cents ≤ autoPayLimitCents, SPEC §6.4, §8); unpaid past
 * seenAt + paymentDeadlineSeconds → overdue; an excluded member's open lines are overdue at
 * once (SPEC §6.7); upheld disputes get a new deadline (SPEC §6.6).
 *
 * Events must already be validated and in seq order; the first one is TRIP_CREATED. The clock
 * is the relay's `receivedAt`. Before each event, every deadline up to its receivedAt fires
 * (at a deadline exactly, the transition has happened), so silent assent uses the policy in
 * force at the deadline; at the end, deadlines fire up to `now`. An event that does not apply
 * to the line's current state (e.g. a contest after silent assent) changes nothing: rejecting
 * it is validateEvent's job. Returns null for an empty log.
 */
export function deriveTrip(events: readonly StoredEvent[], now: Date): TripState | null {
  const first = events[0];
  if (first === undefined) return null;
  if (first.signed.inner.type !== 'TRIP_CREATED') {
    throw new LedgerError('INVALID_EVENT', `the log starts with ${first.signed.inner.type}`);
  }
  const created = first.signed.inner.body;
  const { params } = created;
  const members = new Map<Pubkey, MemberState>();
  const expenses = new Map<string, ExpenseRecord>();
  const lines = new Map<string, LineRecord>();
  const autoPayments = new Map<Pubkey, { at: Date; cents: bigint }[]>();
  const noncesSeen = new Set<string>();
  const fingerprints = new Set<string>();
  let rate: TripState['rate'] = null;
  let closed = false;

  const advance = (line: LineRecord, t: Date) => {
    if (line.state === 'awaiting_decision' && line.seenAt !== null) {
      if (t >= addSeconds(line.seenAt, params.silentAssentSeconds)) {
        const policy = members.get(line.debtorPubkey)?.policy;
        line.state =
          policy !== undefined && line.cents <= policy.autoPayLimitCents
            ? 'due'
            : 'awaiting_explicit';
      }
    }
    if (
      (line.state === 'awaiting_explicit' || line.state === 'due') &&
      line.paymentDeadlineAt !== null &&
      t >= line.paymentDeadlineAt
    ) {
      line.state = 'overdue';
      line.overdueAt = line.paymentDeadlineAt;
    }
  };

  const voidExpense = (expenseEventHash: string) => {
    const expense = expenses.get(expenseEventHash);
    if (expense === undefined || expense.voided) return;
    expense.voided = true;
    fingerprints.delete(expense.body.fingerprint);
    for (const line of lines.values()) {
      if (line.expenseEventHash === expenseEventHash && !isFinal(line)) line.state = 'voided';
    }
  };

  for (const e of events) {
    const at = new Date(e.receivedAt);
    for (const line of lines.values()) advance(line, at);
    const inner = e.signed.inner;
    noncesSeen.add(inner.nonce);
    const lineOf = (expenseEventHash: string, debtor: Pubkey) =>
      lines.get(lineKey(expenseEventHash, debtor));

    switch (inner.type) {
      case 'TRIP_CREATED':
        break;
      case 'RATE_SET':
        rate = { eventHash: e.hash, body: inner.body };
        break;
      case 'MEMBER_JOINED': {
        const b = inner.body;
        members.set(inner.author, {
          memberId: b.memberId,
          displayName: b.displayName,
          pubkey: inner.author,
          nodePubkey: b.nodePubkey,
          policy: b.policy,
          admitted: false,
          channelsReady: false,
          excluded: false,
          closingTxids: [],
          guaranteeUsedCents: 0n,
          oweCents: 0n,
          owedToMeCents: 0n,
        });
        break;
      }
      case 'MEMBER_ADMITTED': {
        const m = members.get(inner.body.memberPubkey);
        if (m) m.admitted = true;
        break;
      }
      case 'POLICY_UPDATED': {
        const m = members.get(inner.author);
        if (m) m.policy = inner.body.policy;
        break;
      }
      case 'CHANNELS_READY': {
        const m = members.get(inner.body.memberPubkey);
        if (m) m.channelsReady = true;
        break;
      }
      case 'EXPENSE_SUBMITTED': {
        const b = inner.body;
        expenses.set(e.hash, {
          eventHash: e.hash,
          seq: e.seq,
          payerPubkey: inner.author,
          submittedAt: at,
          body: b,
          voided: false,
        });
        fingerprints.add(b.fingerprint);
        for (const l of b.lines) {
          if (l.debtorPubkey === inner.author) continue; // the payer owes nothing to themselves
          lines.set(lineKey(e.hash, l.debtorPubkey), {
            expenseEventHash: e.hash,
            expenseId: b.expenseId,
            payerPubkey: inner.author,
            debtorPubkey: l.debtorPubkey,
            cents: l.cents,
            itemIndexes: l.itemIndexes,
            bolt11: l.bolt11,
            state: 'submitted',
            seenAt: null,
            deadlineAt: null,
            paymentDeadlineAt: null,
            overdueAt: null,
            contestReason: null,
            contestedAt: null,
            resolution: null,
            approvedExplicitly: false,
            payment: null,
          });
        }
        break;
      }
      case 'LINE_SEEN': {
        const line = lineOf(inner.body.expenseEventHash, inner.author);
        if (line?.state === 'submitted') {
          line.state = 'awaiting_decision';
          line.seenAt = at;
          line.paymentDeadlineAt = addSeconds(at, params.paymentDeadlineSeconds);
        }
        break;
      }
      case 'LINE_DECIDED': {
        const line = lineOf(inner.body.expenseEventHash, inner.author);
        if (line === undefined) break;
        const undecided =
          line.state === 'submitted' ||
          line.state === 'awaiting_decision' ||
          line.state === 'awaiting_explicit';
        if (undecided && line.seenAt === null) {
          // Decided without a LINE_SEEN: the decision is the moment it was seen.
          line.seenAt = at;
          line.paymentDeadlineAt = addSeconds(at, params.paymentDeadlineSeconds);
        }
        if (inner.body.decision === 'approve') {
          // Approving a due/overdue line (e.g. upheld after a contest) only makes it explicit.
          if (undecided) line.state = 'due';
          if (undecided || line.state === 'due' || line.state === 'overdue')
            line.approvedExplicitly = true;
        } else if (undecided) {
          line.state = 'contested';
          line.contestReason = inner.body.reason ?? null;
          line.contestedAt = at;
        }
        break;
      }
      case 'PAYMENT_MADE': {
        const line = lineOf(inner.body.expenseEventHash, inner.author);
        if (line === undefined || isFinal(line)) break;
        const b = inner.body;
        line.state = 'paid';
        line.payment =
          b.rail === 'ln'
            ? { by: 'debtor', rail: 'ln', paymentHash: b.paymentHash, preimage: b.preimage, at }
            : { by: 'debtor', rail: 'onchain', txid: b.txid, at };
        if (!line.approvedExplicitly) {
          const list = autoPayments.get(inner.author) ?? [];
          list.push({ at, cents: b.cents });
          autoPayments.set(inner.author, list);
        }
        break;
      }
      case 'EXPENSE_VOIDED':
        voidExpense(inner.body.expenseEventHash);
        break;
      case 'DISPUTE_RESOLVED': {
        const b = inner.body;
        const line = lineOf(b.expenseEventHash, b.debtorPubkey);
        if (line?.state !== 'contested') break;
        line.resolution = b.outcome;
        if (b.outcome === 'upheld') {
          line.state = 'due';
          line.approvedExplicitly = false;
          line.paymentDeadlineAt = addSeconds(at, params.paymentDeadlineSeconds);
        } else if (b.outcome === 'line_voided') {
          line.state = 'voided';
        } else {
          voidExpense(b.expenseEventHash);
        }
        break;
      }
      case 'INVOICE_REISSUED': {
        const line = lineOf(inner.body.expenseEventHash, inner.body.debtorPubkey);
        if (line && !isFinal(line)) line.bolt11 = inner.body.bolt11;
        break;
      }
      case 'GUARANTEE_PAID': {
        const b = inner.body;
        const line = lineOf(b.expenseEventHash, b.debtorPubkey);
        if (line === undefined || isFinal(line)) break;
        line.state = 'guaranteed';
        line.payment = { by: 'guarantee', paymentHash: b.paymentHash, preimage: b.preimage, at };
        const debtor = members.get(b.debtorPubkey);
        if (debtor) debtor.guaranteeUsedCents += b.cents;
        break;
      }
      case 'MEMBER_EXCLUDED': {
        const m = members.get(inner.body.memberPubkey);
        if (m) {
          m.excluded = true;
          m.closingTxids = inner.body.closingTxids;
        }
        for (const line of lines.values()) {
          if (line.debtorPubkey === inner.body.memberPubkey && !isFinal(line)) {
            line.state = 'overdue';
            line.overdueAt ??= at;
          }
        }
        break;
      }
      case 'CHECKPOINT':
        break;
      case 'TRIP_CLOSED':
        closed = true;
        break;
    }
  }

  for (const line of lines.values()) {
    advance(line, now);
    line.deadlineAt =
      line.state === 'awaiting_decision' && line.seenAt !== null
        ? addSeconds(line.seenAt, params.silentAssentSeconds)
        : line.state === 'awaiting_explicit' || line.state === 'due'
          ? line.paymentDeadlineAt
          : null;
    if (!isFinal(line)) {
      const debtor = members.get(line.debtorPubkey);
      const payer = members.get(line.payerPubkey);
      if (debtor) debtor.oweCents += line.cents;
      if (payer) payer.owedToMeCents += line.cents;
    }
  }

  const defaults = [...lines.values()]
    .filter((l) => l.state === 'overdue')
    .sort((a, b) => (a.overdueAt?.getTime() ?? 0) - (b.overdueAt?.getTime() ?? 0));
  const last = events[events.length - 1];

  return {
    tripId: first.signed.inner.tripId,
    name: created.name,
    assetId: created.assetId,
    params,
    coordinatorPubkey: created.coordinatorPubkey,
    closed,
    rate,
    members,
    expenses,
    lines,
    defaults,
    autoPayments,
    noncesSeen,
    fingerprints,
    head: last ? { seq: last.seq, hash: last.hash } : null,
  };
}

/** What validateEvent needs from outside, injected so the ledger stays pure (SPEC §9.3). */
export interface ValidationDeps {
  verify: SignatureVerifier;
  /** A JS BOLT11 decoder on the relay; the agent may also use its node's /decodelninvoice. */
  decodeInvoice: (bolt11: string) => DecodedInvoice;
}

export type ValidationResult = { ok: true } | { ok: false; code: 'INVALID_EVENT'; reason: string };

/** Task A2, SPEC §9.3: in validate.ts. */
export { validateEvent } from './validate.js';

/** Task A3, SPEC §8: in autopay.ts. */
export { autoPaidLast24h, decideAutoPay } from './autopay.js';

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
