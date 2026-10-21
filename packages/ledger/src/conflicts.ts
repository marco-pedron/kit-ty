import type { Causality } from './order.js';

// Conflict rules C1-C15 of the registry (plan §2.4, docs/ADR-001-formato-eventi.md §5).
// Each rule is one pure function, so it changes in one place.
//
// Rules that move money look only at causality ("X precedes Y", Causality.precedes) and at
// event types, never at the order between concurrent events: an author can mine its id to
// win a tie-break. The fixed order (Causality.position) decides only "first wins" cases
// where winning gives nothing: duplicates, two devices of the same member.
//
// Inputs are already validated events of the closed set, filtered by the caller (step 2:
// deriveTrip); the functions do not re-check authors or signatures.
//
// Not here until step 2, because they need the member states it derives:
// - C8  EXPENSE_SUBMITTED concurrent with a MEMBER_BLOCKED that would invalidate it;
// - C9  EXPENSE_SUBMITTED concurrent with the debtor's MEMBER_LEFT;
// - C14 MEMBER_INVITED by a member with a concurrent MEMBER_LEFT.
// TODO(step 2): C8, C9, C14; see the it.todo tests in conflicts.test.ts.

export interface Ref {
  readonly id: string;
}

/**
 * The state set by the causally latest events, with `preferred` winning between concurrent
 * latest ones. null when there is none. The shared shape of C1 + C3 and C7.
 */
export function latestCausal<S extends string>(
  c: Causality,
  events: readonly (Ref & { readonly state: S })[],
  preferred: S,
): S | null {
  if (events.length === 0) return null;
  const latest = new Set(c.maxima(events.map((e) => e.id)));
  const states = events.filter((e) => latest.has(e.id)).map((e) => e.state);
  return states.includes(preferred) ? preferred : (states[0] ?? null);
}

/**
 * C1 + C3: the decision of one debtor on one line. In causal sequence the later one counts
 * (a contest is withdrawn only by approving after having seen it); between concurrent
 * decisions `contest` wins.
 */
export function lineDecision(
  c: Causality,
  decisions: readonly (Ref & { readonly decision: 'approve' | 'contest' })[],
): 'approve' | 'contest' | null {
  return latestCausal(
    c,
    decisions.map((d) => ({ id: d.id, state: d.decision })),
    'contest',
  );
}

/**
 * C2 + C11: an expense is voided by any EXPENSE_VOIDED of its payer, wherever it sits, unless
 * a valid PAYMENT_MADE exists for any line of that expense, wherever it sits: the payment wins
 * (money moved). Decisions on its lines never save it (C11).
 */
export function expenseVoided(
  voids: readonly Ref[],
  validPaymentsOfExpense: readonly Ref[],
): boolean {
  return voids.length > 0 && validPaymentsOfExpense.length === 0;
}

/**
 * C4: two valid payments of the same line (original and reissued invoice, two devices). The
 * first in the fixed order pays the line; every other one is a credit of the debtor towards
 * the creditor, to refund by hand. The money moved: nothing is ignored.
 */
export function settleLine<P extends Ref & { readonly amount: bigint }>(
  c: Causality,
  validPayments: readonly P[],
): { paidBy: P | null; overpayments: P[] } {
  const sorted = [...validPayments].sort((a, b) => c.position(a.id) - c.position(b.id));
  return { paidBy: sorted[0] ?? null, overpayments: sorted.slice(1) };
}

/** Sum of the overpayments of settleLine: what the creditor owes back to the debtor. */
export function overpaid(overpayments: readonly { readonly amount: bigint }[]): bigint {
  return overpayments.reduce((sum, p) => sum + p.amount, 0n);
}

/**
 * C5: a payment matches a line if its payment hash is the one of ANY invoice issued for that
 * line (original or INVOICE_REISSUED), concurrent or not with the reissue.
 */
export function paymentMatchesLine(
  paymentHash: string,
  invoicesOfLine: readonly { readonly paymentHash: string }[],
): boolean {
  return invoicesOfLine.some((i) => i.paymentHash === paymentHash);
}

/**
 * C6: concurrent INVOICE_REISSUED of the same line are all valid; the debtor pays the one
 * not yet expired with the smallest event id. Any of them settles the line (C5), so the
 * choice moves no money.
 */
export function invoiceToPay<I extends { readonly eventId: string; readonly expiresAt: number }>(
  invoicesOfLine: readonly I[],
  nowSeconds: number,
): I | null {
  return (
    invoicesOfLine
      .filter((i) => i.expiresAt > nowSeconds)
      .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))[0] ?? null
  );
}

/**
 * C7: MEMBER_BLOCKED / MEMBER_UNBLOCKED of one author on one target. In causal sequence the
 * later one counts; between concurrent ones the block wins (prudent).
 */
export function isBlocked(
  c: Causality,
  events: readonly (Ref & { readonly kind: 'block' | 'unblock' })[],
): boolean {
  return (
    latestCausal(
      c,
      events.map((e) => ({ id: e.id, state: e.kind })),
      'block',
    ) === 'block'
  );
}

/**
 * C10: EXPENSE_SUBMITTED with the same fingerprint. The first in the fixed order is valid,
 * every other one is invalid. `sameAuthor` false = someone else registered the receipt first,
 * shown to the loser as "receipt already registered".
 */
export function duplicateFingerprints<
  E extends Ref & { readonly author: string; readonly fingerprint: string },
>(c: Causality, expenses: readonly E[]): Map<string, { winner: string; sameAuthor: boolean }> {
  const first = new Map<string, E>();
  const losers = new Map<string, { winner: string; sameAuthor: boolean }>();
  for (const e of [...expenses].sort((a, b) => c.position(a.id) - c.position(b.id))) {
    const w = first.get(e.fingerprint);
    if (w === undefined) first.set(e.fingerprint, e);
    else losers.set(e.id, { winner: w.id, sameAuthor: w.author === e.author });
  }
  return losers;
}

/**
 * C12: POLICY_UPDATED of one member (two devices): the last in the fixed order. A policy is a
 * local preference of the member, so winning a tie-break gives nothing.
 */
export function effectivePolicy<U extends Ref>(c: Causality, updates: readonly U[]): U | null {
  return [...updates].sort((a, b) => c.position(b.id) - c.position(a.id))[0] ?? null;
}

/** C13: two MEMBER_JOINED with the same invite: the first in the fixed order, one invite one join. */
export function joinsByInvite<J extends Ref & { readonly inviteRef: string | null }>(
  c: Causality,
  joins: readonly J[],
): { accepted: J[]; rejected: J[] } {
  const used = new Set<string>();
  const accepted: J[] = [];
  const rejected: J[] = [];
  for (const j of [...joins].sort((a, b) => c.position(a.id) - c.position(b.id))) {
    if (j.inviteRef === null) accepted.push(j);
    else if (used.has(j.inviteRef)) rejected.push(j);
    else {
      used.add(j.inviteRef);
      accepted.push(j);
    }
  }
  return { accepted, rejected };
}

/**
 * C15: authors whose personal chain forks (two own events, neither preceding the other: two
 * devices, or an attempt to "forget" something). Both events stay valid; the UI marks the
 * author with "forked registry".
 */
export function forkedAuthors(
  c: Causality,
  events: readonly (Ref & { readonly author: string })[],
): Set<string> {
  const byAuthor = new Map<string, string[]>();
  for (const e of events) byAuthor.set(e.author, [...(byAuthor.get(e.author) ?? []), e.id]);
  const forked = new Set<string>();
  for (const [author, ids] of byAuthor) if (c.maxima(ids).length > 1) forked.add(author);
  return forked;
}

/**
 * C15, second half: the author's heads among the events known at `at` (its ancestors and
 * itself). A block counts as known to the author if it precedes at least one of them; the
 * rule that uses it is C8 (step 2).
 */
export function authorHeads(
  c: Causality,
  events: readonly (Ref & { readonly author: string })[],
  author: string,
  at: string,
): string[] {
  const own = events
    .filter((e) => e.author === author && (e.id === at || c.precedes(e.id, at)))
    .map((e) => e.id);
  return c.sortByOrder(c.maxima(own));
}
