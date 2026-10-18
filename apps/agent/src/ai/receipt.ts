import {
  CURRENCY_EXPONENTS,
  CurrencyCodeSchema,
  ReceiptSchema,
  type CurrencyCode,
  type Receipt,
  type ReceiptItem,
} from '@kitty/shared';
import { z } from 'zod';
import { parsePrintedAmount } from './amounts.js';

// Receipt extraction (SPEC §11), split between the model and code. The model reads the
// numbered OCR rows and says WHICH row is an item (with its label and quantity), the subtotal,
// the tax, the tip and the total. Code reads the amounts from those rows: the model never
// copies, converts or adds up money. Then the deterministic checks add warnings, shown to the
// payer and never silently fixed.

const MAX_ROWS = 80;

export function llmReceiptSchema(rowCount: number) {
  const row = z
    .number()
    .int()
    .min(0)
    .max(Math.max(0, Math.min(rowCount, MAX_ROWS) - 1));
  return z.object({
    merchant: z.string().max(80),
    date: z.string().max(10),
    currency: CurrencyCodeSchema,
    items: z
      .array(
        z.object({
          row,
          label: z.string().min(1).max(80),
          quantity: z.number().int().positive().max(999),
        }),
      )
      .min(1)
      .max(40),
    subtotalRow: row.nullable(),
    taxRow: row.nullable(),
    tipRow: row.nullable(),
    totalRow: row,
  });
}
export type LlmReceipt = z.infer<ReturnType<typeof llmReceiptSchema>>;

/** JSON schema for QVAC's responseFormat: the sampler can only produce this shape. */
export function llmReceiptJsonSchema(rowCount: number) {
  return z.toJSONSchema(llmReceiptSchema(rowCount), { target: 'draft-7' });
}

// An amount as printed: grouped thousands ("255.000", "1,234.56") or plain ("2.50", "38,50").
const AMOUNT = /\d{1,3}(?:[.,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/gu;
// "2 x 65.000", "3 X 0.90", "2×1.25"
const TIP_LABEL = /^\s*(tip|tips|mancia|trinkgeld|pourboire|propina|service|servizio)\b/iu;
const TAX_LABEL = /^\s*(tax|sales tax|vat|iva|mwst|tva)\b/iu;
const QTY_X_UNIT = /(\d{1,3})\s*[xX×]\s*(\d[\d.,']*)/u;

// Numbers that are not prices: a measure ("0,5L", "9PZ", "500 g") or a count ("x2", "×3").
const MEASURE = /\d+(?:[.,]\d+)?\s*(?:l|cl|ml|g|gr|kg|pz|pc|pcs)(?!\p{L})/giu;
const COUNT = /(?<!\p{L})[x×]\s*\d{1,3}(?![\d.,'])/giu;

/** The last amount printed on a row: the line total, the subtotal, the total… */
export function rowAmount(row: string, currency: CurrencyCode): bigint | null {
  // OCR often reads "4,50" as "4, 50"
  const last = row
    .replace(/(\d[.,])\s+(\d)/gu, '$1$2')
    .replace(MEASURE, ' ')
    .replace(COUNT, ' ')
    .match(AMOUNT)
    ?.at(-1);
  return last === undefined ? null : parsePrintedAmount(last, currency);
}

type Conversion =
  { ok: true; receipt: Receipt } | { ok: false; error: string; partial: Partial<Receipt> };

/** LLM output (already JSON) + the OCR rows → Receipt with warnings, or the error to feed back. */
export function toReceipt(value: unknown, rows: readonly string[]): Conversion {
  const parsed = llmReceiptSchema(rows.length).safeParse(value);
  if (!parsed.success) {
    const v = (value ?? {}) as Partial<Record<keyof LlmReceipt, unknown>>;
    const partial: Partial<Receipt> = {};
    if (typeof v.merchant === 'string') partial.merchant = v.merchant;
    const cur = CurrencyCodeSchema.safeParse(v.currency);
    if (cur.success) partial.currency = cur.data;
    return { ok: false, error: z.prettifyError(parsed.error), partial };
  }
  const r = parsed.data;
  const errors: string[] = [];
  const amountOf = (what: string, i: number): bigint => {
    const n = rowAmount(rows[i] ?? '', r.currency);
    if (n === null) errors.push(`${what}: row ${i} "${rows[i]}" has no amount`);
    return n ?? 0n;
  };

  // Structure, not money: an "item" on the total, subtotal, tax or tip row is dropped (and
  // said in the warnings); items are kept in printed order.
  const special = new Map<number, string>();
  const claim = (what: string, i: number | null) => {
    if (i === null) return;
    const prev = special.get(i);
    if (prev !== undefined) errors.push(`row ${i} is both ${prev} and ${what}`);
    special.set(i, what);
  };
  const dropped: string[] = [];
  // A tip or tax line the model listed as an item, when it gave no tip or tax row.
  const byLabel = (re: RegExp) => r.items.find((it) => re.test(it.label))?.row ?? null;
  let { tipRow, taxRow } = r;
  if (tipRow === null && (tipRow = byLabel(TIP_LABEL)) !== null)
    dropped.push(`Row "${rows[tipRow]}" read as the tip.`);
  if (taxRow === null && (taxRow = byLabel(TAX_LABEL)) !== null)
    dropped.push(`Row "${rows[taxRow]}" read as the tax.`);
  claim('the total', r.totalRow);
  claim('the subtotal', r.subtotalRow);
  claim('the tax', taxRow);
  claim('the tip', tipRow);
  const seen = new Set<number>();
  const llmItems = r.items
    .filter((it) => {
      const what = special.get(it.row);
      if (what !== undefined && it.row !== tipRow && it.row !== taxRow)
        dropped.push(`Row "${rows[it.row]}" is ${what}, not an item.`);
      if (what !== undefined || seen.has(it.row)) return false;
      seen.add(it.row);
      return true;
    })
    .sort((a, b) => a.row - b.row);
  if (llmItems.length === 0) errors.push('items: no row is an item');

  // A row without a price (a menu component "+ Fries", a freebie) is part of the item above:
  // dropped and said, never given an amount. Only when no item row has a price is it an error.
  const priced = llmItems.flatMap((it) => {
    const total = rowAmount(rows[it.row] ?? '', r.currency);
    return total === null ? [] : [{ ...it, total }];
  });
  if (llmItems.length > 0 && priced.length === 0)
    llmItems.forEach((it, k) => amountOf(`item ${k}`, it.row));
  else
    for (const it of llmItems)
      if (!priced.some((p) => p.row === it.row))
        dropped.push(`Row "${rows[it.row]}" has no price: not counted as an item.`);

  const items: ReceiptItem[] = priced.map((it) => {
    const total = it.total;
    const m = QTY_X_UNIT.exec(rows[it.row] ?? '');
    const printedUnit = m?.[2] ? parsePrintedAmount(m[2], r.currency) : null;
    // A printed "q x unit" wins over the model's quantity.
    if (m?.[1] && printedUnit !== null)
      return {
        label: it.label.replace(/\s+/gu, ' ').trim(),
        quantity: Number(m[1]),
        unitPrice: printedUnit,
        total,
      };
    const q = BigInt(it.quantity);
    const unitPrice = it.quantity > 1 && total % q === 0n ? total / q : total;
    return {
      label: it.label.replace(/\s+/gu, ' ').trim(),
      quantity: unitPrice === total ? 1 : it.quantity,
      unitPrice,
      total,
    };
  });

  const receipt: Receipt = {
    merchant: r.merchant.trim(),
    date: r.date,
    currency: r.currency,
    items,
    total: amountOf('the total', r.totalRow),
    warnings: [],
  };
  if (r.subtotalRow !== null) receipt.subtotal = amountOf('the subtotal', r.subtotalRow);
  const tax = taxRow === null ? 0n : amountOf('the tax', taxRow);
  const tip = tipRow === null ? 0n : amountOf('the tip', tipRow);
  if (tax > 0n) receipt.tax = tax;
  if (tip > 0n) receipt.tip = tip;
  if (!z.iso.date().safeParse(r.date).success)
    errors.push(`date: "${r.date}" is not a date in the format YYYY-MM-DD`);

  const checked = z.safeEncode(ReceiptSchema, receipt);
  if (!checked.success) errors.push(z.prettifyError(checked.error));
  if (errors.length > 0) {
    const withoutDate: Partial<Receipt> = { ...receipt };
    delete withoutDate.date;
    return {
      ok: false,
      error: errors.join('\n'),
      partial: errors.some((e) => e.startsWith('date')) ? withoutDate : receipt,
    };
  }
  receipt.warnings = [...dropped, ...receiptWarnings(receipt)];
  return { ok: true, receipt };
}

/** Deterministic checks after zod (SPEC §11): items + tax + tip = total, and per line. */
export function receiptWarnings(r: Receipt): string[] {
  const w: string[] = [];
  const fmt = (n: bigint) => formatIn(n, r.currency);
  const sum = r.items.reduce((a, it) => a + it.total, 0n);
  if (r.subtotal !== undefined && r.subtotal !== sum)
    w.push(`The items add up to ${fmt(sum)}, but the subtotal is ${fmt(r.subtotal)}.`);
  const expected = sum + (r.tax ?? 0n) + (r.tip ?? 0n);
  if (expected !== r.total)
    w.push(
      `Items + tax + tip = ${fmt(expected)}, but the total is ${fmt(r.total)}. Check the lines.`,
    );
  r.items.forEach((it, i) => {
    if (it.unitPrice * BigInt(it.quantity) !== it.total)
      w.push(
        `Line ${i + 1} "${it.label}": ${it.quantity} × ${fmt(it.unitPrice)} is not ${fmt(it.total)}.`,
      );
  });
  return w;
}

function formatIn(n: bigint, currency: CurrencyCode): string {
  const exp = CURRENCY_EXPONENTS[currency];
  if (exp === 0) return `${n} ${currency}`;
  const unit = 10n ** BigInt(exp);
  return `${n / unit}.${(n % unit).toString().padStart(exp, '0')} ${currency}`;
}
