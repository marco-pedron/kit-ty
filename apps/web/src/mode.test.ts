import { describe, expect, it } from 'vitest';
import { paymentMode } from './mode.js';

const D = 5000n;

describe('paymentMode, the label of the limit slider', () => {
  it('0 is "Always ask me"', () => {
    expect(paymentMode(0n, D)).toMatchObject({ kind: 'ask', short: 'Always ask me' });
  });

  it('in between is a limit in DUSD', () => {
    expect(paymentMode(2000n, D)).toEqual({
      kind: 'limit',
      short: 'Limit 20.00',
      long: 'Pay automatically up to 20.00 DUSD',
    });
    expect(paymentMode(4950n, D).kind).toBe('limit');
    expect(paymentMode(50n, D).short).toBe('Limit 0.50');
  });

  it('the channel capacity, or more, is "Automatic payment"', () => {
    expect(paymentMode(D, D)).toMatchObject({ kind: 'auto', short: 'Automatic payment' });
    expect(paymentMode(D + 1n, D).kind).toBe('auto');
  });
});
