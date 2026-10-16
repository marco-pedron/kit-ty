import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances } from './balances.js';
import { approveExpense } from './expense.js';
import { MEMBERS, expenseDraft, lockedRate } from './test/arbitraries.js';

const approvedExpense = expenseDraft(MEMBERS).chain((d) =>
  lockedRate(d.currency).map((rate) => approveExpense(d, rate, '2026-10-17T19:31:00.000Z')),
);

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('properties', () => {
  it('(a) per-expense USD shares sum to the converted total; original shares sum to the total', () => {
    fc.assert(
      fc.property(approvedExpense, (e) => {
        expect(sum(e.allocation.usdShares.map((s) => s.amount))).toBe(e.allocation.usdTotalCents);
        expect(sum(e.allocation.originalShares.map((s) => s.amount))).toBe(e.total);
        expect(e.allocation.usdShares.every((s) => s.amount >= 0n)).toBe(true);
      }),
    );
  });

  it('(b) the sum of all nets is 0, with or without settlements', () => {
    fc.assert(
      fc.property(fc.array(approvedExpense, { maxLength: 6 }), (expenses) => {
        const { nets } = computeBalances(MEMBERS, expenses, []);
        expect(sum(nets.map((n) => n.netCents))).toBe(0n);
        // Settling every debtor's net with the first creditor keeps the sum at 0.
        const settlements = nets
          .filter((n) => n.netCents < 0n)
          .map((n, i) => ({
            id: `s${i}`,
            tripId: 't',
            from: n.participant,
            to: nets.find((c) => c.netCents > 0n)?.participant ?? n.participant,
            amountCents: -n.netCents,
            rail: 'onchain' as const,
            status: 'confirmed' as const,
            ref: null,
            createdAt: '2026-10-17T19:31:00.000Z',
          }));
        const after = computeBalances(MEMBERS, expenses, settlements);
        expect(sum(after.nets.map((n) => n.netCents))).toBe(0n);
      }),
    );
  });
});
