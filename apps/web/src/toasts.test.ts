import type { LineView, TripView } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { paymentToasts } from './toasts.js';

const line = (over: Partial<LineView>): LineView =>
  ({
    expenseId: 'x1',
    payer: 'alice',
    debtor: 'bob',
    cents: 309n,
    state: 'awaiting_decision',
    paidBy: null,
    ...over,
  }) as LineView;

const view = (as: 'alice' | 'bob', credits: LineView[], debts: LineView[]): TripView =>
  ({ as, me: { credits, debts } }) as unknown as TripView;

describe('+ty / -ty toasts from two polls of /state', () => {
  it('says nothing on the first poll', () => {
    expect(paymentToasts(null, view('alice', [line({ state: 'paid' })], []))).toEqual([]);
  });

  it('+ty for the payer when a part arrives, from the debtor or the operator', () => {
    const before = view('alice', [line({}), line({ debtor: 'charlie', cents: 350n })], []);
    const after = view(
      'alice',
      [
        line({ state: 'paid', paidBy: 'debtor' }),
        line({ debtor: 'charlie', cents: 350n, state: 'guaranteed', paidBy: 'guarantee' }),
      ],
      [],
    );
    expect(paymentToasts(before, after)).toEqual([
      { id: 'plus:x1:bob', kind: 'plus', prefix: '+ty!', text: '3.09 DUSD from Bob' },
      {
        id: 'plus:x1:charlie',
        kind: 'plus',
        prefix: '+ty!',
        text: '3.50 DUSD from the operator, for Charlie',
      },
    ]);
  });

  it('-ty for the debtor when their own payment goes through', () => {
    const before = view('bob', [], [line({ state: 'due' })]);
    const after = view('bob', [], [line({ state: 'paid', paidBy: 'debtor' })]);
    expect(paymentToasts(before, after)).toEqual([
      {
        id: 'minus:x1:bob',
        kind: 'minus',
        prefix: '-ty!',
        text: 'You settled 3.09 DUSD with Alice',
      },
    ]);
  });

  it('only once, and never for a part the operator covered for me', () => {
    const paid = view('alice', [line({ state: 'paid', paidBy: 'debtor' })], []);
    expect(paymentToasts(paid, paid)).toEqual([]);
    const covered = view('bob', [], [line({ state: 'guaranteed', paidBy: 'guarantee' })]);
    expect(paymentToasts(view('bob', [], [line({ state: 'overdue' })]), covered)).toEqual([]);
  });
});
