import { describe, expect, it } from 'vitest';
import { paymentMode } from './mode.js';

const D = 5000n;

describe('paymentMode, the badge and the slider label of a group', () => {
  it('0 is "Always ask"', () => {
    expect(paymentMode(0n, D)).toEqual({
      kind: 'ask',
      badge: 'Always ask',
      long: 'Always ask me',
    });
  });

  it('in between is a limit in DUSD', () => {
    expect(paymentMode(2000n, D)).toEqual({
      kind: 'limit',
      badge: 'Limit 20.00 DUSD',
      long: 'Pay automatically up to 20.00 DUSD',
    });
    expect(paymentMode(4950n, D).kind).toBe('limit');
    expect(paymentMode(50n, D).badge).toBe('Limit 0.50 DUSD');
  });

  it('the channel capacity, or more, is "Auto mode"', () => {
    expect(paymentMode(D, D)).toEqual({
      kind: 'auto',
      badge: 'Auto mode',
      long: 'Automatic payment',
    });
    expect(paymentMode(D + 1n, D).kind).toBe('auto');
  });
});
