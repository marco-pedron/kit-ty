import { CURRENCY_EXPONENTS, type CurrencyCode } from '@kitty/shared';

// The LLM copies amounts as printed on the receipt ("65.000", "12,50", "1,234.56"); this code,
// never the model, turns them into minor units (CLAUDE.md rule 3, SPEC §11).

/**
 * A printed amount → minor units of `currency`, or null if it is not a plain amount.
 * Exponent 0 (VND, JPY): every "." "," "'" or space is a thousands separator.
 * Exponent 2: the last "." or "," followed by exactly 1-2 digits is the decimal mark; any
 * other separator groups thousands.
 */
export function parsePrintedAmount(printed: string, currency: CurrencyCode): bigint | null {
  if (printed.includes('-')) return null; // receipts' amounts are never negative here
  const s = printed
    .trim()
    .replace(/^[^\d]+/u, '')
    .replace(/[^\d]+$/u, '');
  if (!/^\d[\d., ']*$/u.test(s)) return null;
  const exp = CURRENCY_EXPONENTS[currency];
  if (exp === 0) return BigInt(s.replace(/[., ']/gu, ''));

  const m = /^(.*?)[.,](\d{1,2})$/u.exec(s);
  const whole = (m ? m[1] : s) ?? '';
  const frac = (m ? m[2] : '') ?? '';
  if (!/^\d[\d., ']*$/u.test(whole) && whole !== '') return null;
  const groups = whole.split(/[., ']/u);
  // thousands groups after the first are exactly 3 digits
  if (groups.slice(1).some((g) => g.length !== 3)) return null;
  const major = BigInt(groups.join('') || '0');
  return major * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0'));
}
