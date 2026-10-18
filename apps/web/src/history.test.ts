import type { ExpenseView, LineView } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { approvalText, formatFiat, historyRows } from './history.js';

const line = (over: Partial<LineView>): LineView =>
  ({
    expenseId: 'x1',
    payer: 'alice',
    debtor: 'bob',
    cents: 1744n,
    state: 'awaiting_decision',
    paidBy: null,
    agent: null,
    resolution: null,
    ...over,
  }) as LineView;

const taxi = (lines: LineView[], over: Partial<ExpenseView> = {}): ExpenseView =>
  ({
    expenseId: 'x1',
    payer: 'alice',
    merchant: 'Taxi',
    submittedAt: '2026-10-17T12:00:00.000Z',
    totalUsdCents: 5232n,
    currency: 'VND',
    receiptTotal: 1378000n,
    status: 'open',
    lines,
    ...over,
  }) as ExpenseView;

const none = () => false;

describe('history rows as the wireframe draws them', () => {
  it('the payer sees what arrived, then the expense with who still owes', () => {
    const e = taxi([
      line({ state: 'paid', paidBy: 'debtor' }),
      line({ debtor: 'charlie', state: 'due' }),
    ]);
    const rows = historyRows([e], 'alice', none);
    expect(rows.map((r) => [r.title, r.subtitle, r.cents, r.sign])).toEqual([
      ['Bob paid you', '+ty! · Taxi', 1744n, '+'],
      ['Taxi', 'You paid · Charlie owes 17.44 DUSD', 5232n, '-'],
    ]);
    expect(rows[1]?.waitingSince).toBeNull();
    expect(rows[0]?.fiat).toBeNull();
    expect(rows[1]?.fiat).toEqual({
      amount: '1,378,000',
      currency: 'VND',
      rateLockedAt: '2026-10-17T12:00:00.000Z',
    });
  });

  it('waits for the agents, then says who owes, "all settled", and names the operator', () => {
    const waiting = taxi([line({}), line({ debtor: 'charlie' })]);
    expect(historyRows([waiting], 'alice', none)[0]).toMatchObject({
      subtitle: 'You paid · Waiting for Bob and Charlie…',
      waitingSince: '2026-10-17T12:00:00.000Z',
    });
    const open = taxi([line({ state: 'due' }), line({ debtor: 'charlie', state: 'overdue' })]);
    expect(historyRows([open], 'alice', none)[0]?.subtitle).toBe(
      'You paid · Bob and Charlie owe 17.44 DUSD',
    );
    const done = taxi([
      line({ state: 'paid', paidBy: 'debtor' }),
      line({ debtor: 'charlie', state: 'guaranteed', paidBy: 'guarantee' }),
    ]);
    const rows = historyRows([done], 'alice', none);
    expect(rows[1]?.title).toBe('Operator paid for Charlie');
    expect(rows[2]?.subtitle).toBe('You paid · all settled');
  });

  it('a debtor sees their part with a minus, and not the parts waiting for them', () => {
    const paid = taxi([
      line({
        state: 'paid',
        paidBy: 'debtor',
        agent: { pay: false, reason: 'Paid 17.44 to alice: you approved it.' },
      }),
    ]);
    expect(historyRows([paid], 'bob', none)[0]).toMatchObject({
      title: 'Taxi',
      subtitle: 'Alice paid · -ty! · you approved',
      cents: 1744n,
      sign: '-',
    });
    const waiting = taxi([line({})]);
    expect(historyRows([waiting], 'bob', () => true)).toEqual([]);
  });
});

describe('approval card text', () => {
  it('counts down under the limit, asks above it', () => {
    expect(approvalText(line({ cents: 210n }), 'Coffee', 2000n, 38)).toEqual({
      title: 'Alice paid · 2.10 DUSD · Coffee',
      sentence: 'Paying in 0:38 unless you dispute',
    });
    expect(approvalText(line({}), 'Taxi', 1000n, 102).sentence).toBe(
      'Above your limit of 10.00 DUSD: I need your OK',
    );
    expect(approvalText(line({}), 'Taxi', 0n, 10).sentence).toBe(
      'You asked me to always ask: I need your OK',
    );
    expect(
      approvalText(
        line({ state: 'due', resolution: { outcome: 'upheld', note: '' } }),
        'Taxi',
        0n,
        10,
      ).sentence,
    ).toBe('Dave upheld it: I need your OK');
  });
});

describe('fiat amounts', () => {
  it('groups thousands and keeps the currency decimals', () => {
    expect(formatFiat(255000n, 'VND')).toBe('255,000');
    expect(formatFiat(123456n, 'EUR')).toBe('1,234.56');
    expect(formatFiat(5n, 'USD')).toBe('0.05');
  });
});
