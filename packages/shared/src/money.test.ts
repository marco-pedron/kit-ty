import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatCents, minorString, moneyString, parseCents, positiveMinorString } from './money.js';

describe('money codec', () => {
  it('decodes decimal strings to bigint and back', () => {
    expect(z.decode(minorString, '309')).toBe(309n);
    expect(z.encode(minorString, 309n)).toBe('309');
    expect(z.decode(moneyString, '-7')).toBe(-7n);
  });

  it('rejects floats, numbers and out-of-range values', () => {
    expect(minorString.safeParse('3.09').success).toBe(false);
    expect(minorString.safeParse(309).success).toBe(false);
    expect(minorString.safeParse('-1').success).toBe(false);
    expect(positiveMinorString.safeParse('0').success).toBe(false);
  });

  it('keeps values beyond Number.MAX_SAFE_INTEGER exact', () => {
    expect(z.decode(minorString, '90071992547409930')).toBe(90071992547409930n);
  });
});

describe('formatCents / parseCents', () => {
  it.each([
    [309n, '3.09'],
    [5000n, '50.00'],
    [-7n, '-0.07'],
    [0n, '0.00'],
  ])('formats %s as %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it.each([
    ['20', 2000n],
    ['20.5', 2050n],
    [' 20.50 ', 2050n],
    ['0.07', 7n],
  ])('parses %s', (text, cents) => {
    expect(parseCents(text)).toBe(cents);
  });

  it.each(['', '-1', '1.234', '1,50', 'abc', '.5'])('rejects %j', (text) => {
    expect(parseCents(text)).toBeNull();
  });
});
