import { z } from 'zod';

// The one money codec (CLAUDE.md rule 3): bigint minor units in TypeScript, decimal strings
// of minor units on the wire ("309" = 3.09 DUSD). Decode with `z.decode`, encode with `z.encode`.
// 1 cent = 1 DUSD unit (asset precision 2).

const integerString = z.string().regex(/^-?\d+$/, 'expected an integer string like "309"');
const codec = { decode: (s: string) => BigInt(s), encode: (n: bigint) => n.toString() };

/** Signed: nets and balances can be negative. */
export const moneyString = z.codec(integerString, z.bigint(), codec);
/** ≥ 0. */
export const minorString = z.codec(integerString, z.bigint().nonnegative(), codec);
/** > 0. */
export const positiveMinorString = z.codec(integerString, z.bigint().positive(), codec);

// ISO 4217 code → number of minor-unit digits. Unknown currencies are an error, never a default.
export const CURRENCY_EXPONENTS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  VND: 0,
  JPY: 0,
} as const;
export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;
const currencyCodes = Object.keys(CURRENCY_EXPONENTS) as [CurrencyCode, ...CurrencyCode[]];
export const CurrencyCodeSchema = z.enum(currencyCodes);

/** A positive decimal written as a string, e.g. "26350" or "0.86". Never a JS number. */
export const DecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected a decimal string like "26350.5"');

/** USD cents for display: 309n → "3.09", -7n → "-0.07". */
export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * Base units of an asset for display, with `shown` decimals (the trip's displayDecimals):
 * formatUnits(309n, 2) → "3.09"; formatUnits(3_090_000n, 6, 2) → "3.09". Digits below `shown`
 * are cut (shares are rounded to them, TripParams).
 */
export function formatUnits(amount: bigint, decimals: number, shown = decimals): string {
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  if (shown === 0) return `${sign}${whole}`;
  const frac = (abs % unit).toString().padStart(decimals, '0').slice(0, shown).padEnd(shown, '0');
  return `${sign}${whole}.${frac}`;
}

/** User input "20", "20.5", "20.50" → 2050n; anything else (more than 2 decimals, signs) → null. */
export function parseCents(input: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}
