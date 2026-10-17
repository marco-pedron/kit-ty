import type { ExpenseDraft, LockedRate, Receipt } from '@kitty/shared';
import { allocateExpense } from './expense.js';
import { LedgerError, assertUniqueIds } from './errors.js';

// The shares of a signed expense (SPEC §6.3, §9.3), recomputed by the payer's agent before
// submitting and by every validator after: receipt + who shares which items + locked rate →
// USD cents per person. Party ids are author pubkeys, so the largest-remainder ties are broken
// the same way by everyone.

export interface ShareInput {
  receipt: Receipt;
  /** Units of the receipt currency per 1 USD, as in EXPENSE_SUBMITTED.rate. */
  rate: string;
  payer: string;
  payerItemIndexes: readonly number[];
  debtors: readonly { id: string; itemIndexes: readonly number[] }[];
}

export interface ShareResult {
  totalUsdCents: bigint;
  payerCents: bigint;
  /** Same order as `input.debtors`. */
  debtors: { id: string; cents: bigint }[];
}

/**
 * Items are split equally among the people who share them, tax + tip proportionally to the
 * item subtotals, the total converted once and allocated in USD cents (expense.ts). Every item
 * with a non-zero total must be shared by someone; indexes must exist on the receipt.
 */
export function expenseShares(input: ShareInput): ShareResult {
  const { receipt, payer, debtors } = input;
  const parties = [
    { id: payer, itemIndexes: input.payerItemIndexes },
    ...debtors.map((d) => ({ id: d.id, itemIndexes: d.itemIndexes })),
  ];
  assertUniqueIds(
    parties.map((p) => p.id),
    'expense parties',
  );

  const sharedBy = receipt.items.map((): string[] => []);
  for (const p of parties) {
    assertUniqueIds(
      p.itemIndexes.map((i) => `${i}`),
      `items of ${p.id}`,
    );
    for (const i of p.itemIndexes) {
      const people = sharedBy[i];
      if (people === undefined) {
        throw new LedgerError('INVALID_ASSIGNMENT', `item ${i} does not exist on the receipt`, {
          itemIndex: i,
          participant: p.id,
        });
      }
      people.push(p.id);
    }
  }

  const items = receipt.items.map((item, i) => {
    const participants = sharedBy[i] ?? [];
    if (participants.length === 0 && item.total > 0n) {
      throw new LedgerError('INVALID_ASSIGNMENT', `item ${i} (${item.label}) is shared by nobody`, {
        itemIndex: i,
      });
    }
    return { label: item.label, amount: item.total, participants };
  });

  const draft: ExpenseDraft = {
    id: 'expense',
    tripId: 'trip',
    description: receipt.merchant,
    currency: receipt.currency,
    items,
    extras: {
      ...(receipt.tax !== undefined && { tax: receipt.tax }),
      ...(receipt.tip !== undefined && { tip: receipt.tip }),
    },
    total: receipt.total,
    payer,
    participants: parties.map((p) => p.id),
  };
  // Only currency and value are used for the conversion.
  const rate: LockedRate = {
    currency: receipt.currency,
    value: input.rate,
    asOf: receipt.date,
    source: 'table',
    lockedAt: `${receipt.date}T00:00:00.000Z`,
  };
  const { usdTotalCents, usdShares } = allocateExpense(draft, rate);
  const cents = new Map(usdShares.map((s) => [s.participant, s.amount]));
  return {
    totalUsdCents: usdTotalCents,
    payerCents: cents.get(payer) ?? 0n,
    debtors: debtors.map((d) => ({ id: d.id, cents: cents.get(d.id) ?? 0n })),
  };
}
