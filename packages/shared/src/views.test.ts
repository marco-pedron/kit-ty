import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatCents } from './money.js';
import { TripViewSchema, type LineView, type TripView } from './views.js';
import { AT, HASH, emptyState } from './test/samples.js';

const coordinatorView: NonNullable<TripView['coordinator']> = {
  members: [
    {
      memberId: 'charlie',
      guaranteeUsedCents: 350n,
      guaranteeLeftCents: 4650n,
      operatorCreditCents: 350n,
      liquidityMarginCents: 2650n,
    },
  ],
  disputes: [],
  defaults: [],
};

function credit(
  debtor: 'bob' | 'charlie',
  cents: bigint,
  paidBy: 'debtor' | 'guarantee',
): LineView {
  return {
    expenseId: 'e1',
    expenseEventHash: HASH('a'),
    payer: 'alice',
    debtor,
    cents,
    itemIndexes: [0],
    state: paidBy === 'debtor' ? 'paid' : 'guaranteed',
    seenAt: AT,
    deadlineAt: null,
    contestReason: null,
    resolution: null,
    agent: null,
    paidBy,
    proof: { rail: 'ln', paymentHash: HASH(debtor === 'bob' ? '1' : '2') },
    invoiceExpiresAt: AT,
  };
}

describe('TripView privacy', () => {
  it('a traveler never gets the coordinator view, neither decoding nor encoding', () => {
    const leaked = { ...emptyState, coordinator: coordinatorView };
    expect(() => z.encode(TripViewSchema, leaked)).toThrow(/coordinator view/);
    const wire = {
      ...z.encode(TripViewSchema, emptyState),
      coordinator: z.encode(TripViewSchema, {
        ...emptyState,
        as: 'dave',
        role: 'coordinator',
        me: null,
        coordinator: coordinatorView,
      }).coordinator,
    };
    expect(TripViewSchema.safeParse(wire).success).toBe(false);
  });

  it('dave gets the coordinator view and no traveler view', () => {
    const dave: TripView = {
      ...emptyState,
      as: 'dave',
      role: 'coordinator',
      me: null,
      coordinator: coordinatorView,
    };
    expect(
      z.decode(TripViewSchema, JSON.parse(JSON.stringify(z.encode(TripViewSchema, dave)))),
    ).toEqual(dave);
    expect(() => z.encode(TripViewSchema, { ...dave, me: emptyState.me })).toThrow(/traveler view/);
  });

  it('a traveler gets only their own view, with a matching role', () => {
    expect(() => z.encode(TripViewSchema, { ...emptyState, as: 'alice' })).toThrow(/own view/);
    expect(() => z.encode(TripViewSchema, { ...emptyState, role: 'coordinator' })).toThrow(/role/);
  });
});

describe('me.credits (demo step 7)', () => {
  it('tells alice who reimbursed her and how, with the proof reference', () => {
    const alice: TripView = {
      ...emptyState,
      as: 'alice',
      me: {
        ...emptyState.me!,
        memberId: 'alice',
        debts: [],
        credits: [credit('bob', 309n, 'debtor'), credit('charlie', 350n, 'guarantee')],
      },
    };
    const back = z.decode(
      TripViewSchema,
      JSON.parse(JSON.stringify(z.encode(TripViewSchema, alice))),
    );
    const credits = back.me!.credits;
    const total = credits.reduce((s, l) => s + l.cents, 0n);
    const parts = credits.map((l) =>
      l.paidBy === 'guarantee'
        ? `${formatCents(l.cents)} guaranteed by the operator`
        : `${formatCents(l.cents)} from ${l.debtor}`,
    );
    expect(`Reimbursed ${formatCents(total)}: ${parts.join(', ')}`).toBe(
      'Reimbursed 6.59: 3.09 from bob, 3.50 guaranteed by the operator',
    );
    expect(credits.every((l) => l.proof?.rail === 'ln')).toBe(true);
  });
});
