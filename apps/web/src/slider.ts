import type { ExpenseView, MemberView } from '@kitty/shared';

// The one limit slider (PM decision, FLOWS.md §B): from 0 to the trip channel capacity D in
// steps of 0.50 DUSD. The <input type=range> works in whole steps; the limit stays bigint.

export const STEP_CENTS = 50n;

/** Number of steps from 0 to D (D rounded down to a step). */
export const sliderSteps = (channelCents: bigint): number => Number(channelCents / STEP_CENTS);

export const limitFromStep = (step: number): bigint => BigInt(step) * STEP_CENTS;

/** The slider position of a limit: rounded down to a step, clamped to [0, D]. */
export function stepFromLimit(limitCents: bigint, channelCents: bigint): number {
  const max = sliderSteps(channelCents);
  if (limitCents <= 0n) return 0;
  const step = Number(limitCents / STEP_CENTS);
  return step > max ? max : step;
}

export type MemberStanding = 'active' | 'insolvent' | 'excluded' | 'joining';

/** Excluded by dave; insolvent while one of their parts is overdue; else active. */
export function memberStanding(m: MemberView, expenses: readonly ExpenseView[]): MemberStanding {
  if (m.status === 'excluded') return 'excluded';
  if (m.status !== 'active') return 'joining';
  const overdue = expenses.some((e) =>
    e.lines.some((l) => l.debtor === m.memberId && l.state === 'overdue'),
  );
  return overdue ? 'insolvent' : 'active';
}
