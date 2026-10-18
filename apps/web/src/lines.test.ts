import type { LineView } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { canApprove, canDispute, formatCountdown, needsMe, secondsLeft } from './lines.js';

const line = (over: Partial<LineView>): LineView => ({
  expenseId: 'x1',
  expenseEventHash: 'a'.repeat(64),
  payer: 'alice',
  debtor: 'bob',
  cents: 309n,
  itemIndexes: [0],
  state: 'awaiting_decision',
  seenAt: null,
  deadlineAt: null,
  contestReason: null,
  resolution: null,
  agent: null,
  paidBy: null,
  proof: null,
  invoiceExpiresAt: '2026-10-17T12:00:00.000Z',
  ...over,
});

describe('countdown on the server clock', () => {
  const deadline = '2026-10-17T12:00:45.000Z';
  const browser = Date.parse('2026-10-17T12:00:00.000Z');

  it('counts whole seconds up to the deadline', () => {
    expect(secondsLeft(deadline, 0, browser)).toBe(45);
    expect(secondsLeft(deadline, 0, browser + 44_100)).toBe(1);
  });

  it('follows the server when the browser clock is off', () => {
    // The browser is 10 s behind the server: 35 s left, not 45.
    expect(secondsLeft(deadline, 10_000, browser)).toBe(35);
  });

  it('is 0 at and after the deadline, null without one', () => {
    expect(secondsLeft(deadline, 0, browser + 45_000)).toBe(0);
    expect(secondsLeft(deadline, 0, browser + 60_000)).toBe(0);
    expect(secondsLeft(null, 0, browser)).toBeNull();
  });

  it('formats minutes and seconds', () => {
    expect(formatCountdown(45)).toBe('0:45');
    expect(formatCountdown(120)).toBe('2:00');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('what a debtor can do on a part', () => {
  it('approves and disputes an undecided part', () => {
    for (const state of ['submitted', 'awaiting_decision', 'awaiting_explicit'] as const) {
      expect(canApprove(line({ state }))).toBe(true);
      expect(canDispute(line({ state }))).toBe(true);
    }
  });

  it('cannot dispute once due, paid or overdue', () => {
    for (const state of ['due', 'overdue', 'paid', 'guaranteed', 'voided', 'contested'] as const)
      expect(canDispute(line({ state }))).toBe(false);
  });

  it('approves a part dave upheld until it is approved', () => {
    const upheld = { outcome: 'upheld' as const, note: '' };
    const waiting = line({
      state: 'due',
      resolution: upheld,
      agent: { pay: false, reason: 'Dave upheld …' },
    });
    expect(canApprove(waiting)).toBe(true);
    expect(needsMe(waiting)).toBe(true);
    const approved = line({ state: 'due', resolution: upheld, agent: { pay: true, reason: '' } });
    expect(canApprove(approved)).toBe(false);
    expect(canApprove(line({ state: 'due' }))).toBe(false);
  });

  it('still approves an upheld part after its deadline: the agent pays it late', () => {
    const upheld = { outcome: 'upheld' as const, note: '' };
    const late = line({
      state: 'overdue',
      resolution: upheld,
      agent: { pay: false, reason: 'Overdue: …' },
    });
    expect(canApprove(late)).toBe(true);
    expect(needsMe(late)).toBe(true);
    expect(canApprove({ ...late, agent: { pay: true, reason: '' } })).toBe(false);
    // an overdue part never disputed has nothing to approve: the operator covers it
    expect(canApprove(line({ state: 'overdue', agent: { pay: false, reason: '' } }))).toBe(false);
  });
});
