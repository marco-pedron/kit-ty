import { expenseShares, type MemberState, type TripState } from '@kitty/ledger';
import type { MemberId, Receipt, SplitAssignment, SplitPreview } from '@kitty/shared';
import { FlowError } from './errors.js';

// From a receipt and an assignment (AI proposal, corrected by the payer) to the shares the
// ledger computes with the rate of the day (SPEC §6.3). The LLM never computes money.

export interface ExpensePlan {
  rate: string;
  rateAsOf: string;
  rateEventHash: string;
  totalUsdCents: bigint;
  payerCents: bigint;
  payerItemIndexes: number[];
  debtors: { member: MemberState; itemIndexes: number[]; cents: bigint }[];
}

/** The travelers who can share an expense now: admitted, not excluded, never dave. */
export function activeTravelers(trip: TripState): MemberState[] {
  return [...trip.members.values()].filter((m) => m.admitted && !m.excluded);
}

export function planExpense(
  trip: TripState,
  payer: MemberState,
  receipt: Receipt,
  assignments: readonly SplitAssignment[],
): ExpensePlan {
  if (trip.closed) throw new FlowError('NOT_ALLOWED', 'the trip is closed');
  if (!payer.admitted || payer.excluded)
    throw new FlowError('NOT_ALLOWED', `${payer.memberId} cannot submit expenses`);
  if (trip.rate === null) throw new FlowError('MISSING_RATE', 'no rate of the day yet');
  const rate = receipt.currency === 'USD' ? '1' : trip.rate.body.rates[receipt.currency];
  if (rate === undefined)
    throw new FlowError('MISSING_RATE', `no ${receipt.currency} rate in the rate of the day`);

  const byId = new Map<MemberId, MemberState>(activeTravelers(trip).map((m) => [m.memberId, m]));
  const items = new Map<MemberId, number[]>();
  const assigned = new Set<number>();
  for (const a of assignments) {
    if (a.itemIndex >= receipt.items.length)
      throw new FlowError('INVALID_ASSIGNMENT', `item ${a.itemIndex} is not on the receipt`);
    if (assigned.has(a.itemIndex))
      throw new FlowError('INVALID_ASSIGNMENT', `item ${a.itemIndex} is assigned twice`);
    assigned.add(a.itemIndex);
    for (const id of new Set(a.members)) {
      if (!byId.has(id))
        throw new FlowError('UNKNOWN_PARTICIPANT', `${id} is not an active traveler`);
      items.set(id, [...(items.get(id) ?? []), a.itemIndex]);
    }
  }
  const missing = receipt.items.findIndex((_, i) => !assigned.has(i));
  if (missing >= 0) throw new FlowError('INVALID_ASSIGNMENT', `item ${missing} is not assigned`);

  const debtors = [...items]
    .filter(([id]) => id !== payer.memberId)
    .map(([id, itemIndexes]) => ({ member: byId.get(id) as MemberState, itemIndexes }));
  if (debtors.length === 0)
    throw new FlowError('EMPTY_ALLOCATION', 'nobody else shares this expense');
  const payerItemIndexes = items.get(payer.memberId) ?? [];

  const shares = expenseShares({
    receipt,
    rate,
    payer: payer.pubkey,
    payerItemIndexes,
    debtors: debtors.map((d) => ({ id: d.member.pubkey, itemIndexes: d.itemIndexes })),
  });
  return {
    rate,
    rateAsOf: trip.rate.body.asOf,
    rateEventHash: trip.rate.eventHash,
    totalUsdCents: shares.totalUsdCents,
    payerCents: shares.payerCents,
    payerItemIndexes,
    debtors: debtors.map((d, i) => {
      const cents = shares.debtors[i]?.cents ?? 0n;
      if (cents === 0n)
        throw new FlowError('EMPTY_ALLOCATION', `the share of ${d.member.memberId} rounds to 0.00`);
      return { ...d, cents };
    }),
  };
}

/** The SplitPreview of POST /expenses/split: shares per member, the payer included. */
export function previewOf(plan: ExpensePlan, payer: MemberId): SplitPreview {
  return {
    rate: plan.rate,
    rateAsOf: plan.rateAsOf,
    totalUsdCents: plan.totalUsdCents,
    shares: [
      { member: payer, cents: plan.payerCents },
      ...plan.debtors.map((d) => ({ member: d.member.memberId, cents: d.cents })),
    ],
  };
}
