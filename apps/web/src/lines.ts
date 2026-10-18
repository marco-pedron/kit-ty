import type { LineState, LineView } from '@kitty/shared';

// What a traveler can do on one of their parts, and how to show it. Mirrors the ledger rules
// (packages/ledger/src/validate.ts, LINE_DECIDED): the agent refuses anything else anyway.

const UNDECIDED: readonly LineState[] = ['submitted', 'awaiting_decision', 'awaiting_explicit'];

/** Dispute is possible only before the part is due: during the window, or above the limit. */
export const canDispute = (l: LineView): boolean => UNDECIDED.includes(l.state);

/**
 * Approve: an undecided part, or a part dave upheld that the agent will not pay on its own
 * (payUpheldDisputes off) and that is not approved yet.
 */
export function canApprove(l: LineView): boolean {
  if (UNDECIDED.includes(l.state)) return true;
  return l.state === 'due' && l.resolution?.outcome === 'upheld' && l.agent?.pay === false;
}

/** A part waiting for me: shown as the inline card with the agent's sentence and the buttons. */
export const needsMe = (l: LineView): boolean => canApprove(l) || canDispute(l);

export const LINE_LABEL: Record<LineState, string> = {
  submitted: 'Sent',
  awaiting_decision: 'Dispute window',
  awaiting_explicit: 'Needs approval',
  contested: 'Disputed',
  due: 'Due',
  overdue: 'Insolvent',
  paid: 'Paid',
  guaranteed: 'Covered by the operator',
  voided: 'Voided',
};

/** Whole seconds until `deadlineAt` on the server clock; 0 once passed, null without deadline. */
export function secondsLeft(
  deadlineAt: string | null,
  clockOffsetMs: number,
  browserNowMs: number,
): number | null {
  if (deadlineAt === null) return null;
  const ms = Date.parse(deadlineAt) - (browserNowMs + clockOffsetMs);
  return ms <= 0 ? 0 : Math.ceil(ms / 1000);
}

/** 45 → "0:45", 120 → "2:00". */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The traveler's net position under the balance (DESIGN.md §7): "+ty" when the others owe me
 * more than I owe, "-ty" when I owe more, null when even. Open lines only, from /state.
 */
export function netPosition(me: {
  oweCents: bigint;
  owedToMeCents: bigint;
}): { kind: 'plus' | 'minus'; cents: bigint } | null {
  const net = me.owedToMeCents - me.oweCents;
  if (net === 0n) return null;
  return net > 0n ? { kind: 'plus', cents: net } : { kind: 'minus', cents: -net };
}
