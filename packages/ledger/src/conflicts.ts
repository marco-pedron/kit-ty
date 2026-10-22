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
// All rules are decided (docs/proposte/regole-conflitto.md, 22/10/2026): [T] = from the team
// document (docs/stack-a-decisioni.md), [D] = decided by the team on 22/10.
//
// Here: the rules that need only causality. With the member states of step 2 (deriveTrip,
// validateEvent) come C7 (unblock), C8 (block between payer and debtor, D6), C9 (debt after
// leaving), C13 (one invite, one join) and C14 (invite and concurrent leave).
// TODO(step 2): C7, C8, C9, C13, C14; see the it.todo tests in conflicts.test.ts.

export interface Ref {
  readonly id: string;
}

/**
 * C1 [T] + C3 [D]: the decision of one debtor on one line, from that debtor's decisions. The
 * causally latest counts: an approve that has the debtor's contest among its ancestors
 * withdraws it (C3). Between concurrent latest decisions the contest wins (C1).
 */
export function lineDecision(
  c: Causality,
  decisions: readonly (Ref & { readonly decision: 'approve' | 'contest' })[],
): 'approve' | 'contest' | null {
  if (decisions.length === 0) return null;
  const latest = new Set(c.maxima(decisions.map((d) => d.id)));
  return decisions.some((d) => latest.has(d.id) && d.decision === 'contest')
    ? 'contest'
    : 'approve';
}

/**
 * C2 [T] + C11 [D]: the lines of an expense voided by its payer's EXPENSE_VOIDED, wherever it
 * sits. A line with a valid PAYMENT_MADE, wherever it sits, stays (due and settled): the
 * payment wins only for the paid line (C2). Decisions on a line never save it (C11).
 */
export function voidedLines<L>(
  voids: readonly Ref[],
  lines: readonly L[],
  paidLines: ReadonlySet<L>,
): Set<L> {
  return new Set(voids.length === 0 ? [] : lines.filter((l) => !paidLines.has(l)));
}

/**
 * C4 [D]: two valid payments of the same line (original and reissued invoice, two devices). The
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
 * C5 [D]: a payment matches a line if its payment hash is the one of ANY invoice issued for that
 * line (original or INVOICE_REISSUED), concurrent or not with the reissue.
 */
export function paymentMatchesLine(
  paymentHash: string,
  invoicesOfLine: readonly { readonly paymentHash: string }[],
): boolean {
  return invoicesOfLine.some((i) => i.paymentHash === paymentHash);
}

/**
 * C6 [D]: concurrent INVOICE_REISSUED of the same line are all valid; the debtor pays the one
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
 * C10 [D]: EXPENSE_SUBMITTED with the same fingerprint are all valid, each marked "possible
 * duplicate" of the others; the debtors contest the wrong one (C1). The fixed order invalidates
 * none: the winner would become the creditor, so a tie-break would move money.
 * Returns, for each marked expense, the ids of the others with its fingerprint.
 */
export function possibleDuplicates(
  expenses: readonly (Ref & { readonly fingerprint: string })[],
): Map<string, string[]> {
  const byFingerprint = new Map<string, string[]>();
  for (const e of expenses)
    byFingerprint.set(e.fingerprint, [...(byFingerprint.get(e.fingerprint) ?? []), e.id]);
  const marked = new Map<string, string[]>();
  for (const ids of byFingerprint.values())
    if (ids.length > 1)
      for (const id of ids)
        marked.set(
          id,
          ids.filter((x) => x !== id),
        );
  return marked;
}

export interface PolicyLimits {
  readonly autoPayLimit: bigint;
  readonly dailyCap: bigint;
}

/**
 * C12 [D]: POLICY_UPDATED of one member. In causal sequence the later counts; between
 * concurrent latest ones (two devices) the most prudent, field by field: the lowest
 * autoPayLimit and the lowest dailyCap.
 */
export function effectivePolicy(
  c: Causality,
  updates: readonly (Ref & { readonly policy: PolicyLimits })[],
): PolicyLimits | null {
  const latest = new Set(c.maxima(updates.map((u) => u.id)));
  const policies = updates.filter((u) => latest.has(u.id)).map((u) => u.policy);
  const [first, ...rest] = policies;
  if (first === undefined) return null;
  return rest.reduce<PolicyLimits>(
    (p, q) => ({
      autoPayLimit: q.autoPayLimit < p.autoPayLimit ? q.autoPayLimit : p.autoPayLimit,
      dailyCap: q.dailyCap < p.dailyCap ? q.dailyCap : p.dailyCap,
    }),
    first,
  );
}

/**
 * C15 [D]: authors whose personal chain forks (two own events, neither preceding the other: two
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
 * C15 [D], second half: the author's heads among the events known at `at` (its ancestors and
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
