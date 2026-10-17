import type { ExpenseView, MemberView } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { paymentMode } from './mode.js';
import { limitFromStep, memberStanding, sliderSteps, stepFromLimit } from './slider.js';

const D = 5000n;

describe('limit slider from 0 to the channel capacity, steps of 0.50', () => {
  it('has 100 steps for 50.00', () => {
    expect(sliderSteps(D)).toBe(100);
    expect(limitFromStep(0)).toBe(0n);
    expect(limitFromStep(40)).toBe(2000n);
    expect(limitFromStep(100)).toBe(D);
  });

  it('places a limit on the slider, rounded down and clamped', () => {
    expect(stepFromLimit(2000n, D)).toBe(40);
    expect(stepFromLimit(2049n, D)).toBe(40);
    expect(stepFromLimit(0n, D)).toBe(0);
    expect(stepFromLimit(999_999n, D)).toBe(100);
  });

  it('labels both ends and the middle', () => {
    expect(paymentMode(limitFromStep(0), D).long).toBe('Always ask me');
    expect(paymentMode(limitFromStep(100), D).long).toBe('Automatic payment');
    expect(paymentMode(limitFromStep(21), D).long).toBe('Pay automatically up to 10.50 DUSD');
  });
});

describe('member standing in Group settings', () => {
  const member = (memberId: 'alice' | 'bob' | 'charlie', status: MemberView['status']) =>
    ({ memberId, status }) as MemberView;
  const expenses = [
    {
      lines: [
        { debtor: 'charlie', state: 'overdue' },
        { debtor: 'bob', state: 'paid' },
      ],
    },
  ] as unknown as ExpenseView[];

  it('is insolvent with an overdue part, excluded once dave excluded them', () => {
    expect(memberStanding(member('charlie', 'active'), expenses)).toBe('insolvent');
    expect(memberStanding(member('bob', 'active'), expenses)).toBe('active');
    expect(memberStanding(member('charlie', 'excluded'), expenses)).toBe('excluded');
    expect(memberStanding(member('alice', 'admitted'), expenses)).toBe('joining');
  });
});
