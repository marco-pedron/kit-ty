import type { ExpenseView, TripView } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import {
  ago,
  daveHash,
  daveRouteFromHash,
  daveSwipe,
  guaranteeLeft,
  parseRate,
  rateLine,
  splitOf,
} from './dave.js';

describe("Dave's routes", () => {
  it('reads and writes the hash, with a line for dispute and cover', () => {
    expect(daveRouteFromHash('')).toEqual({ name: 'home' });
    expect(daveRouteFromHash('#/members')).toEqual({ name: 'members' });
    expect(daveRouteFromHash('#/dispute/x1/charlie')).toEqual({
      name: 'dispute',
      expenseId: 'x1',
      member: 'charlie',
    });
    expect(daveRouteFromHash('#/cover/x1')).toEqual({ name: 'home' });
    expect(daveHash({ name: 'cover', expenseId: 'x1', member: 'charlie' })).toBe(
      '#/cover/x1/charlie',
    );
    expect(daveHash({ name: 'home' })).toBe('');
    const h = 'cd'.repeat(32);
    expect(daveRouteFromHash(`#/proof/${h}`)).toEqual({ name: 'proof', paymentHash: h });
    expect(daveHash({ name: 'proof', paymentHash: h })).toBe(`#/proof/${h}`);
  });

  it('swipes left to Members and right to Log, and back', () => {
    expect(daveSwipe('home', -80, 0)).toEqual({ name: 'members' });
    expect(daveSwipe('home', 80, 0)).toEqual({ name: 'log' });
    expect(daveSwipe('members', 80, 0)).toEqual({ name: 'home' });
    expect(daveSwipe('log', -80, 0)).toEqual({ name: 'home' });
    expect(daveSwipe('home', 20, 0)).toBeNull();
    expect(daveSwipe('dispute', -80, 0)).toBeNull();
  });
});

describe('helpers of the operator screens', () => {
  it('says how long ago', () => {
    const t = Date.parse('2026-10-17T12:00:00Z');
    expect(ago('2026-10-17T11:59:18Z', t)).toBe('0:42 ago');
    expect(ago('2026-10-17T11:58:00Z', t)).toBe('2 min ago');
    expect(ago('2026-10-17T10:00:00Z', t)).toBe('2 h ago');
  });

  it('sums the guarantee left over the members', () => {
    const state = {
      coordinator: { members: [{ guaranteeLeftCents: 5000n }, { guaranteeLeftCents: 1500n }] },
    } as unknown as TripView;
    expect(guaranteeLeft(state)).toBe(6500n);
  });

  it('accepts only positive decimal rates', () => {
    expect(parseRate('0.86')).toBe('0.86');
    expect(parseRate(' 26350 ')).toBe('26350');
    expect(parseRate('0,9')).toBe('0.9');
    expect(parseRate('0')).toBeNull();
    expect(parseRate('-1')).toBeNull();
    expect(parseRate('abc')).toBeNull();
    expect(rateLine('EUR', '0.86')).toBe('1 DUSD = 0.86 EUR');
  });

  it('splits an expense, payer first', () => {
    const e = {
      payer: 'alice',
      payerCents: 309n,
      lines: [
        { debtor: 'bob', cents: 309n },
        { debtor: 'charlie', cents: 350n },
      ],
    } as unknown as ExpenseView;
    expect(splitOf(e).map((x) => [x.member, x.cents])).toEqual([
      ['alice', 309n],
      ['bob', 309n],
      ['charlie', 350n],
    ]);
  });
});
