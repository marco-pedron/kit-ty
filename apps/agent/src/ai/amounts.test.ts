import { describe, expect, it } from 'vitest';
import { parsePrintedAmount } from './amounts.js';

describe('parsePrintedAmount', () => {
  it.each([
    ['65.000', 'VND', 65_000n],
    ['255,000', 'VND', 255_000n],
    ['255 000 đ', 'VND', 255_000n],
    ['12,50', 'EUR', 1250n],
    ['12.5', 'EUR', 1250n],
    ['1.234,56', 'EUR', 123_456n],
    ['1,234.56', 'USD', 123_456n],
    ['$9.68', 'USD', 968n],
    ['12.500', 'EUR', 1_250_000n],
    ['7', 'USD', 700n],
  ] as const)('%s %s → %s', (printed, currency, expected) => {
    expect(parsePrintedAmount(printed, currency)).toBe(expected);
  });

  it.each([['abc'], [''], ['12.3.4,5,6'], ['1,23,456.00'], ['-5']])('%s is not an amount', (p) => {
    expect(parsePrintedAmount(p, 'USD')).toBeNull();
  });
});
