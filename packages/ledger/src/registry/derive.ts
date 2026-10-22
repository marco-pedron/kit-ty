import type { registry } from '@kitty/shared';
import {
  forkedAuthors,
  invoiceToPay,
  lineDecision,
  overpaid,
  possibleDuplicates,
  type PolicyLimits,
} from '../conflicts.js';
import { fixedOrder } from '../order.js';
import {
  blockersOf,
  blocks,
  fold,
  isExcluded,
  isOpen,
  memberPolicy,
  settlement,
  voidedOf,
  type Fold,
  type LineRecord,
} from './fold.js';
import { unixSeconds, validateRegistryEvent, type RegistryDeps } from './validate.js';

// deriveRegistry (step 2): the trip as every phone computes it from the registry v2 events it
// has. No coordinator, no relay clock: line states at `now` (unix seconds, the phone's clock).
// Same events, any arrival order → same result (properties test).

export type RegistryLineState =
  | 'submitted'
  | 'awaiting_decision'
  | 'awaiting_explicit'
  | 'due'
  | 'manual_only'
  | 'contested'
  | 'paid'
  | 'voided';

export interface RegistryLine {
  key: string;
  expenseRef: string;
  payer: string;
  debtor: string;
  amount: bigint;
  itemIndexes: readonly number[];
  state: RegistryLineState;
  /** Why the line is manual_only: the pair is blocked, or the creditor is excluded [T]. */
  manualOnly: 'blocked' | 'creditor_excluded' | null;
  /** Signed at the table or approved by the debtor: not an automatic payment (decideAutoPay). */
  approvedExplicitly: boolean;
  signedAtTable: boolean;
  /** C9: the expense is concurrent with the debtor's MEMBER_LEFT; no silent assent. */
  afterLeaving: boolean;
  seenAt: number | null;
  /** End of silent assent, while awaiting_decision. */
  deadlineAt: number | null;
  contestReason: string | null;
  /** The invoice to pay now (C6): unexpired, smallest event id; null if none. */
  invoice: string | null;
  /** Every invoice issued for the line (C5). */
  invoices: readonly string[];
  payment: LineRecord['payments'][number] | null;
  /** C4: what the creditor owes back to the debtor for payments after the first. */
  overpaid: bigint;
}

export interface RegistryMember {
  pubkey: string;
  displayName: string;
  nodePubkey: string;
  invitedBy: string | null;
  policy: PolicyLimits;
  left: boolean;
  excluded: boolean;
  /** Members keeping a block in force on this one. */
  blockedBy: readonly string[];
  /** C15: two own events with no causal relation. */
  forked: boolean;
}

export interface RegistryTrip {
  tripId: string;
  name: string;
  params: registry.TripParams;
  creator: string;
  members: ReadonlyMap<string, RegistryMember>;
  /** Expense event id → its fold record, with the C10 mark. */
  expenses: ReadonlyMap<
    string,
    { payer: string; body: registry.EventBody<'EXPENSE_SUBMITTED'>; possibleDuplicateOf: string[] }
  >;
  lines: ReadonlyMap<string, RegistryLine>;
  /** Automatic payments per debtor ({ at: created_at, amount }), for the daily cap. */
  autoPayments: ReadonlyMap<string, readonly { at: number; amount: bigint }[]>;
  /** Events of the closed set that break a rule, with the reason. */
  rejected: readonly { id: string; reason: string }[];
  /** Events that wait for a missing parent (not applied yet). */
  waiting: readonly string[];
  frontier: readonly string[];
  stateHash: string;
  /** Every member has left [T]. */
  finished: boolean;
  /** The time-free state, for expenseRefusal and the app. */
  fold: Fold;
}

/**
 * Derives the trip from `events` (decoded and signature-checked by the caller) at `now`.
 * Every event is validated on the fold of its own ancestors, in the fixed order (memoized),
 * then the valid ones are folded together and the line states computed at `now`.
 * Null when there is no TRIP_CREATED genesis.
 */
export function deriveRegistry(
  events: readonly registry.RegistryEvent[],
  deps: RegistryDeps,
  now: number,
): RegistryTrip | null {
  const fo = fixedOrder(events);
  const c = fo.causality;
  const [genesis] = fo.order;
  if (genesis?.content.type !== 'TRIP_CREATED') return null;

  const byId = new Map(fo.order.map((e) => [e.id, e]));
  const rejected = new Map<string, string>();
  for (const e of fo.order) {
    if (e === genesis) continue;
    const ancestors = c
      .ancestorsOf(e.id)
      .filter((id) => !rejected.has(id))
      .map((id) => byId.get(id) as registry.RegistryEvent);
    const known = fold(c, ancestors);
    const reason =
      known === null ? 'no trip among the ancestors' : validateRegistryEvent(e, known, deps);
    if (reason !== null) rejected.set(e.id, reason);
  }
  const valid = fo.order.filter((e) => !rejected.has(e.id));
  const f = fold(c, valid) as Fold;

  const forked = forkedAuthors(
    c,
    valid.map((e) => ({ id: e.id, author: e.author })),
  );
  const members = new Map<string, RegistryMember>();
  for (const m of f.members.values()) {
    members.set(m.pubkey, {
      pubkey: m.pubkey,
      displayName: m.displayName,
      nodePubkey: m.nodePubkey,
      invitedBy: m.invitedBy,
      policy: memberPolicy(f, m.pubkey) as PolicyLimits,
      left: m.leftId !== null,
      excluded: isExcluded(f, m.pubkey),
      blockedBy: blockersOf(f, m.pubkey),
      forked: forked.has(m.pubkey),
    });
  }

  const duplicates = possibleDuplicates(
    [...f.expenses.values()].map((x) => ({ id: x.id, fingerprint: x.body.fingerprint })),
  );
  const expenses = new Map(
    [...f.expenses.values()].map((x) => [
      x.id,
      { payer: x.payer, body: x.body, possibleDuplicateOf: duplicates.get(x.id) ?? [] },
    ]),
  );

  const lines = new Map<string, RegistryLine>();
  const autoPayments = new Map<string, { at: number; amount: bigint }[]>();
  for (const l of f.lines.values()) {
    const line = lineAt(f, l, now, members, deps);
    lines.set(l.key, line);
    if (line.payment !== null && !line.approvedExplicitly) {
      const list = autoPayments.get(l.debtor) ?? [];
      list.push({ at: line.payment.createdAt, amount: line.payment.amount });
      autoPayments.set(l.debtor, list);
    }
  }

  return {
    tripId: f.tripId,
    name: f.created.name,
    params: f.created.params,
    creator: f.creator,
    members,
    expenses,
    lines,
    autoPayments,
    rejected: [...rejected].map(([id, reason]) => ({ id, reason })),
    waiting: fo.waiting.map((e) => e.id),
    frontier: fo.frontier,
    stateHash: fo.stateHash,
    finished: members.size > 0 && [...members.values()].every((m) => m.left),
    fold: f,
  };
}

function lineAt(
  f: Fold,
  l: LineRecord,
  now: number,
  members: ReadonlyMap<string, RegistryMember>,
  deps: RegistryDeps,
): RegistryLine {
  const expense = f.expenses.get(l.expenseRef);
  const debtor = f.members.get(l.debtor);
  const { paidBy, overpayments } = settlement(f, l);
  const decision = lineDecision(f.c, l.decisions);
  // C9: the expense did not know the debtor's leave (if it had, it would be invalid).
  const afterLeaving =
    debtor?.leftId != null && expense !== undefined && f.c.concurrent(expense.id, debtor.leftId);
  const policy = members.get(l.debtor)?.policy;
  const latestContest = l.decisions.filter((d) => d.decision === 'contest').at(-1);

  let state: RegistryLineState;
  let deadlineAt: number | null = null;
  if (paidBy !== null) state = 'paid';
  else if (expense !== undefined && voidedOf(f, expense).has(l.debtor)) state = 'voided';
  else if (decision === 'contest') state = 'contested';
  else if (decision === 'approve' || l.signedAtTable) state = 'due';
  else if (l.seen === null) state = 'submitted';
  else if (afterLeaving) state = 'awaiting_explicit';
  else {
    deadlineAt = l.seen.createdAt + f.created.params.silentAssentSeconds;
    if (now < deadlineAt) state = 'awaiting_decision';
    else {
      state = policy !== undefined && l.amount <= policy.autoPayLimit ? 'due' : 'awaiting_explicit';
      deadlineAt = null;
    }
  }

  // [T] "Debiti verso chi è bloccato o escluso: niente pagamento automatico, si paga a mano".
  // The block counts per pair (D6), in either direction; a third party's block does not.
  let manualOnly: RegistryLine['manualOnly'] = null;
  if (blocks(f, l.debtor, l.payer) || blocks(f, l.payer, l.debtor)) manualOnly = 'blocked';
  else if (isExcluded(f, l.payer)) manualOnly = 'creditor_excluded';
  if (state === 'due' && manualOnly !== null) state = 'manual_only';

  const expiries = l.invoices.map((i) => {
    try {
      return {
        ...i,
        expiresAt: unixSeconds(deps.decodeInvoice(i.bolt11).expiresAt),
      };
    } catch {
      return { ...i, expiresAt: 0 };
    }
  });
  return {
    key: l.key,
    expenseRef: l.expenseRef,
    payer: l.payer,
    debtor: l.debtor,
    amount: l.amount,
    itemIndexes: l.itemIndexes,
    state,
    manualOnly,
    approvedExplicitly: l.signedAtTable || decision === 'approve',
    signedAtTable: l.signedAtTable,
    afterLeaving,
    seenAt: l.seen?.createdAt ?? null,
    deadlineAt,
    contestReason: state === 'contested' ? (latestContest?.reason ?? null) : null,
    invoice: invoiceToPay(expiries, now)?.bolt11 ?? null,
    invoices: l.invoices.map((i) => i.bolt11),
    payment: paidBy === null ? null : (l.payments.find((p) => p.id === paidBy.id) ?? null),
    overpaid: overpaid(overpayments),
  };
}

/** Whether a line is still a debt (not paid, not voided), contested ones included. */
export function lineIsOpen(trip: RegistryTrip, key: string): boolean {
  const l = trip.fold.lines.get(key);
  return l !== undefined && isOpen(trip.fold, l);
}
