import type { Receipt } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { formatMinor, parseMinor, receiptGap, withItemTotal } from './receipt-edit.js';

const dinner: Receipt = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    { label: 'Bia Saigon x3', quantity: 3, unitPrice: 25_000n, total: 75_000n },
    { label: 'Water', quantity: 3, unitPrice: 10_000n, total: 30_000n },
  ],
  tip: 20_000n,
  total: 255_000n,
  warnings: [],
};

describe('amounts in the receipt currency', () => {
  it('formats with the currency exponent', () => {
    expect(formatMinor(255_000n, 'VND')).toBe('255000');
    expect(formatMinor(4500n, 'EUR')).toBe('45.00');
    expect(formatMinor(5n, 'USD')).toBe('0.05');
  });

  it('parses what the user types, refusing extra decimals', () => {
    expect(parseMinor('45', 'EUR')).toBe(4500n);
    expect(parseMinor('45.5', 'EUR')).toBe(4550n);
    expect(parseMinor('255,000', 'VND')).toBe(255_000n);
    expect(parseMinor('1.5', 'VND')).toBeNull();
    expect(parseMinor('4.555', 'EUR')).toBeNull();
    expect(parseMinor('-3', 'EUR')).toBeNull();
    expect(parseMinor('abc', 'EUR')).toBeNull();
  });
});

describe('editing the receipt', () => {
  it('finds the gap between items, tax, tip and total', () => {
    expect(receiptGap(dinner)).toBe(0n);
    expect(receiptGap({ ...dinner, total: 250_000n })).toBe(5_000n);
  });

  it('keeps the unit price when the new total divides by the quantity', () => {
    const r = withItemTotal(dinner, 0, 140_000n);
    expect(r.items[0]).toMatchObject({ quantity: 2, unitPrice: 70_000n, total: 140_000n });
    expect(r.items[1]).toBe(dinner.items[1]);
  });

  it('becomes one item at the new total otherwise', () => {
    expect(withItemTotal(dinner, 1, 80_000n).items[1]).toMatchObject({
      quantity: 1,
      unitPrice: 80_000n,
      total: 80_000n,
    });
  });
});
