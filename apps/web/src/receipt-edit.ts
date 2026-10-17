import { CURRENCY_EXPONENTS, type CurrencyCode, type Receipt } from '@kitty/shared';

// Editing a receipt read by the AI, in minor units of its own currency (VND has none, EUR and
// USD have cents). Amounts stay bigint; the strings are only what the user types and sees.

/** 255000n VND → "255000"; 4500n EUR → "45.00". */
export function formatMinor(amount: bigint, currency: CurrencyCode): string {
  const exp = CURRENCY_EXPONENTS[currency];
  if (exp === 0) return amount.toString();
  const base = 10n ** BigInt(exp);
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  return `${sign}${abs / base}.${(abs % base).toString().padStart(exp, '0')}`;
}

/** "45", "45.5", "45.50" → 4550n for EUR; "255000" → 255000n for VND; anything else → null. */
export function parseMinor(input: string, currency: CurrencyCode): bigint | null {
  const exp = CURRENCY_EXPONENTS[currency];
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > exp) return null;
  return BigInt(m[1] ?? '0') * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0');
}

/** items + tax + tip − total: 0 when the receipt adds up (shown, never fixed silently). */
export function receiptGap(r: Receipt): bigint {
  const items = r.items.reduce((a, it) => a + it.total, 0n);
  return items + (r.tax ?? 0n) + (r.tip ?? 0n) - r.total;
}

/** A new total for one item: unit price follows when it divides, else the item becomes 1 × total. */
export function withItemTotal(r: Receipt, index: number, total: bigint): Receipt {
  return {
    ...r,
    items: r.items.map((it, i) => {
      if (i !== index) return it;
      const q = BigInt(it.quantity);
      return total % q === 0n
        ? { ...it, total, unitPrice: total / q }
        : { ...it, total, quantity: 1, unitPrice: total };
    }),
  };
}
