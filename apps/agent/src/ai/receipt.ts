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
const TIP_LABEL = /^\s*(tip|tips|mancia|trinkgeld|pourboire|propina|service|servizio)\b/iu;
// A tax named anywhere on the row: "Sales tax", "Thue VAT 8%", "MwSt 19%".
const TAX_WORD = /(?<!\p{L})(tax|vat|iva|mwst|tva|gst|thue)(?!\p{L})/iu;
const TOTAL_LABEL = /^\s*(total|totale|tong\s+cong|summe|gesamt|amount\s+due)(?!\p{L})/iu;
const SUBTOTAL_LABEL =
  /(?<!\p{L})(sub\s*-?\s*total|subtot|tam\s+tinh|totale\s+parziale|zwischensumme)(?!\p{L})/iu;
// Words of a row that are not a product: units, currencies, a count sign.
const NOT_PRODUCT = new Set([
  'kg',
  'gr',
  'lt',
  'ml',
  'cl',
  'pz',
  'pc',
  'pcs',
  'lb',
  'oz',
  'eur',
  'usd',
  'vnd',
]);

/** Whether a label names something: a word of 2 or more letters that is not a unit or currency. */
const namesProduct = (label: string) =>
  (label.toLowerCase().match(/\p{L}{2,}/gu) ?? []).some((w) => !NOT_PRODUCT.has(w));
// "2 x 65.000", "3 X 0.90", "2×1.25", "2*1,50": a count times a unit price. Not a weight
// ("0,412 x 3,20 EUR/kg": the count is a decimal) and not a pack size ("6X1,5L": the "unit"
// is a measure).
const QTY_X_UNIT = /(?<![\d.,'])(\d{1,3})\s*[xX×*]\s*(\d[\d.,']*)(?![\d.,'])(?!\s*\p{L})/u;

// Numbers that are not prices: a measure ("0,5L", "9PZ", "500 g") or a count ("x2", "×3", "*2").
const MEASURE = /\d+(?:[.,]\d+)?\s*(?:l|cl|ml|g|gr|kg|pz|pc|pcs)(?!\p{L})/giu;
const COUNT = /(?<!\p{L})[x×*]\s*\d{1,3}(?![\d.,'])/giu;

/** The words of a label or row that name something: letters only, 3 or more, lowercase. */
const wordsOf = (s: string) => new Set(s.toLowerCase().match(/\p{L}{3,}/gu) ?? []);

/**
 * The row of an item, checked against its label. The model sometimes gives an item the row
 * next to its own (on a photographed receipt: "Rice crackers" on the noodles' row); its label
 * says which row it meant. If the label's words are not on the given row but on exactly one
 * other row, that row; otherwise the model's row. Structure only: the amount is still read
 * from the row by code.
 */
export function anchorRow(label: string, row: number, rows: readonly string[]): number {
  const words = [...wordsOf(label)];
  if (words.length === 0) return row;
  const carries = (i: number) => {
    const w = wordsOf(rows[i] ?? '');
    return words.every((x) => w.has(x));
  };
  if (carries(row)) return row;
  const others = rows.map((_, i) => i).filter((i) => i !== row && carries(i));
  return others.length === 1 ? (others[0] ?? row) : row;
}

/** A row with the OCR's usual damage to its numbers undone; words are left as read. */
export function cleanNumbers(row: string, currency: CurrencyCode): string {
  // OCR often reads "4,50" as "4, 50", "4 ,50" or "4 , 50", and "45.000" as "45 .000"
  let text = row.replace(/(\d)\s*([.,])\s*(\d)/gu, '$1$2$3');
  // the letter O for a zero inside a number: "130 00o", "o311"
  text = text.replace(/(?<![\p{L}\d.,])[\dOo.,]*\d[\dOo.,]*(?![\p{L}\d.,])/gu, (n) =>
    n.replace(/[Oo]/gu, '0'),
  );
  // without decimals, a lost thousands dot leaves "10  000" at the end of the row
  if (CURRENCY_EXPONENTS[currency] === 0)
    text = text.replace(/(?<![\d.,])(\d{1,3})\s+(\d{3})\s*$/u, '$1.$2');
  // with decimals, a lost decimal mark leaves "0  80" at the end of the row
  else text = text.replace(/(?<![\d.,])(\d{1,3})\s+(\d{2})\s*$/u, '$1,$2');
  return text;
}

/** Text compared as printed: no case, accents, spaces or punctuation ("Water (1.5L)" = "Water 1.5L"). */
const compact = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The product name printed on an item row: the row without its "q x unit", its price per
 * measure ("@ 1.10/kg", "2,49 EUR/kg"), the amounts and VAT codes at the end ("2,58 A") and a
 * count at the start ("2 x MENU", or "X NUGGETS" when the OCR lost the digit). Measures that
 * are part of the name stay ("Water 1.5L", "NUGGETS 9PZ").
 */
export function rowLabel(row: string, currency: CurrencyCode): string {
  return cleanNumbers(row, currency)
    .replace(new RegExp(QTY_X_UNIT.source, 'gu'), ' ')
    .replace(/@?\s*\d[\d.,']*\s*(?:[€$£]|EUR|USD|VND)?\s*\/\s*\p{L}+/giu, ' ')
    .replace(/(?:\s+[€$£]?\s*\d[\d.,']*\s*[€$£đ]?(?:\s+\p{Lu}(?!\p{L}))?)+\s*$/u, '')
    .replace(/^\s*(?:\d{1,3}\s*)?[xX×*]\s+(?=\p{L})/u, '')
    .replace(/[^\p{L}\p{N})\]]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The label of an item: the model's when it is the printed name (its casing, its "(0.73 kg)"),
 * else the name printed on the row. A 1.7B model shortens names ("Pho" for "Pho bo") or copies
 * prices into them ("Banh mi 27.000"); the row has the name as printed.
 */
function itemLabel(label: string, row: string, currency: CurrencyCode): string {
  const printed = rowLabel(row, currency);
  const own = label.replace(/\s+/gu, ' ').trim();
  return /\p{L}{2,}/u.test(printed) && compact(printed) !== compact(own) ? printed : own;
}

/**
 * The merchant as printed in the header (the rows above the items): the model's name when a
 * header row prints it; the whole row when the model gave part of it ("VESUVIO" of
 * "PIZZERIA VESUVIO"); else, when the model's name is not printed there (made up, or an item's
 * name), the first header row with a name.
 */
export function printedMerchant(merchant: string, header: readonly string[]): string {
  const named = header.filter((h) => /\p{L}{2,}/u.test(h) && printedDate([h], 'EUR') === null);
  const tidy = (h: string) => h.replace(/\s+/gu, ' ').trim();
  if (named.some((h) => compact(h) === compact(merchant))) return merchant.trim();
  const words = [...wordsOf(merchant)];
  const carrying = named.find((h) => words.length > 0 && words.every((w) => wordsOf(h).has(w)));
  if (carrying !== undefined) return tidy(carrying);
  return named[0] === undefined ? merchant.trim() : tidy(named[0]);
}

/** The amounts printed on a row, in order, as printed and in minor units. */
function amountsOf(row: string, currency: CurrencyCode): { printed: string; minor: bigint }[] {
  const text = cleanNumbers(row, currency).replace(MEASURE, ' ').replace(COUNT, ' ');
  return (text.match(AMOUNT) ?? []).flatMap((printed) => {
    const minor = parsePrintedAmount(printed, currency);
    return minor === null ? [] : [{ printed, minor }];
  });
}

/**
 * The amount of a row: the line total, the subtotal, the total… The last one printed; with
 * decimals, the last one with its decimals ("2,34 C" read as "2,34 0" is 2,34, not 0).
 */
export function rowAmount(row: string, currency: CurrencyCode): bigint | null {
  const amounts = amountsOf(row, currency);
  if (CURRENCY_EXPONENTS[currency] > 0) {
    const withDecimals = amounts.filter((a) => /[.,]\d{2}$/u.test(a.printed));
    if (withDecimals.length > 0) return withDecimals.at(-1)?.minor ?? null;
  }
  return amounts.at(-1)?.minor ?? null;
}

/**
 * The unit price printed before the line total, when the total is a whole multiple of it:
 * "MENU CLASSIC  8,90  17,80" is 2 × 8,90, even when the OCR lost the "2 x".
 */
function unitBefore(row: string, total: bigint, currency: CurrencyCode) {
  const amounts = amountsOf(row, currency);
  const at = amounts.map((a) => a.minor).lastIndexOf(total);
  const [u, t] = [amounts[at - 1], amounts[at]];
  if (at < 1 || u === undefined || t === undefined) return null;
  // printed like a price, like the total: "6X1,5L  2,34" has no unit price "6"
  const shape = (p: string) => /[.,']\d+$/u.test(p);
  if (shape(u.printed) !== shape(t.printed)) return null;
  const unit = u.minor;
  if (unit <= 0n || total % unit !== 0n) return null;
  const q = total / unit;
  return q >= 2n && q <= 99n ? { quantity: Number(q), unitPrice: unit } : null;
}

// A printed date: "17/10/2026", "10/16/2026", "17.10.2026", "2026-10-17".
const DMY = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/u;
const YMD = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/u;

/**
 * The date printed on the receipt as YYYY-MM-DD, read by code like the amounts: day/month/year,
 * except month/day/year on a USD receipt; the other order only if the first is not a date.
 */
export function printedDate(rows: readonly string[], currency: CurrencyCode): string | null {
  const iso = (y: string, m: string, d: string) => {
    const s = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return z.iso.date().safeParse(s).success ? s : null;
  };
  for (const row of rows) {
    const ymd = YMD.exec(row);
    if (ymd?.[1] && ymd[2] && ymd[3]) {
      const s = iso(ymd[1], ymd[2], ymd[3]);
      if (s) return s;
    }
    const m = DMY.exec(row);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const [a, b, y] = [m[1], m[2], m[3]];
    const s = currency === 'USD' ? (iso(y, a, b) ?? iso(y, b, a)) : (iso(y, b, a) ?? iso(y, a, b));
    if (s) return s;
  }
  return null;
}

/** A count printed on the row: "2 x 65.000", "x2", or a leading "2 Pho bo". */
function hasPrintedCount(row: string, quantity: number, currency: CurrencyCode): boolean {
  const q = String(quantity);
  // not a pack size: "6X1,5L" is one pack of 6 bottles
  return new RegExp(
    `(?<![\\d.,])${q}\\s*[xX×*](?!\\s*\\d[\\d.,']*\\s*\\p{L})|[xX×*]\\s*${q}(?![\\d.,])|^\\s*${q}\\s+\\p{L}`,
    'u',
  ).test(cleanNumbers(row, currency));
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
  // said in the warnings); items are kept in printed order. Every rule below only says which
  // row is what, never changes an amount, and says what it did in the warnings.
  const special = new Map<number, string>();
  const claim = (what: string, i: number | null) => {
    if (i === null) return;
    const prev = special.get(i);
    if (prev !== undefined) errors.push(`row ${i} is both ${prev} and ${what}`);
    special.set(i, what);
  };
  const dropped: string[] = [];
  const totalRow = r.totalRow;
  // A tip or tax line the model listed as an item, when it gave no tip or tax row: above the
  // total ("di cui IVA 2,44" below it is VAT already in the total).
  const byLabel = (re: RegExp) =>
    r.items.find((it) => it.row < totalRow && (re.test(it.label) || re.test(rows[it.row] ?? '')))
      ?.row ?? null;
  let { tipRow, taxRow } = r;
  if (tipRow === null && (tipRow = byLabel(TIP_LABEL)) !== null)
    dropped.push(`Row "${rows[tipRow]}" read as the tip.`);
  if (taxRow === null && (taxRow = byLabel(TAX_WORD)) !== null)
    dropped.push(`Row "${rows[taxRow]}" read as the tax.`);
  // Optional rows with no amount ("IVA inclusa" given as the tax) are not read as that row.
  const withAmount = (what: string, i: number | null) => {
    if (i === null || rowAmount(rows[i] ?? '', r.currency) !== null) return i;
    dropped.push(`Row "${rows[i]}" has no amount: not read as ${what}.`);
    return null;
  };
  let subtotalRow = withAmount('the subtotal', r.subtotalRow);
  taxRow = withAmount('the tax', taxRow);
  tipRow = withAmount('the tip', tipRow);

  // The items the model listed, on the row their label is on; never the date row (its time
  // would read as a price), nothing printed after the total (payment, change, VAT summary,
  // loyalty points), never a row that names no product ("247", "0,734 kg x 2,49 EUR/kg").
  const seen = new Set<number>();
  const listed = r.items
    .map((it) => ({ ...it, row: anchorRow(it.label, it.row, rows) }))
    .filter((it) => {
      if (seen.has(it.row)) return false;
      seen.add(it.row);
      return true;
    })
    .sort((a, b) => a.row - b.row)
    .filter((it) => {
      const row = rows[it.row] ?? '';
      if (it.row === totalRow) return true; // said below, as before
      if (printedDate([row], r.currency) !== null) {
        dropped.push(`Row "${row}" is the date, not an item.`);
        return false;
      }
      if (it.row > totalRow) {
        dropped.push(`Row "${row}" is after the total, not an item.`);
        return false;
      }
      if (TOTAL_LABEL.test(row) && !SUBTOTAL_LABEL.test(row)) {
        dropped.push(`Row "${row}" is a total, not an item.`);
        return false;
      }
      if (!namesProduct(rowLabel(row, r.currency))) {
        dropped.push(`Row "${row}" names no product, not an item.`);
        return false;
      }
      return true;
    });

  // A subtotal, tax or tip is printed between the items and the total: one above an item is
  // not one (then the item the model also listed it as stays), one below the total is not
  // added to it ("di cui IVA": VAT included).
  const lastItem = Math.max(
    -1,
    ...listed
      .map((it) => it.row)
      .filter((i) => i !== totalRow && i !== subtotalRow && i !== taxRow && i !== tipRow),
  );
  const between = (what: string, i: number | null) => {
    if (i === null) return null;
    if (i > totalRow) {
      dropped.push(`Row "${rows[i]}" is after the total: not added as ${what}.`);
      return null;
    }
    if (i < lastItem) {
      dropped.push(`Row "${rows[i]}" is above an item: not ${what}.`);
      return null;
    }
    return i;
  };
  subtotalRow = between('the subtotal', subtotalRow);
  taxRow = between('the tax', taxRow);
  tipRow = between('the tip', tipRow);
  claim('the total', totalRow);
  claim('the subtotal', subtotalRow);
  claim('the tax', taxRow);
  claim('the tip', tipRow);
  const llmItems = listed.filter((it) => {
    const what = special.get(it.row);
    if (what !== undefined && it.row !== tipRow && it.row !== taxRow)
      dropped.push(`Row "${rows[it.row]}" is ${what}, not an item.`);
    return what === undefined;
  });
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
    const m = QTY_X_UNIT.exec(cleanNumbers(rows[it.row] ?? '', r.currency));
    const printedUnit = m?.[2] ? parsePrintedAmount(m[2], r.currency) : null;
    // A printed "q x unit" wins over the model's quantity.
    if (m?.[1] && printedUnit !== null)
      return {
        label: itemLabel(it.label, rows[it.row] ?? '', r.currency),
        quantity: Number(m[1]),
        unitPrice: printedUnit,
        total,
      };
    // The model's quantity only when the row prints it: "Birra media 5,50" is 1, not 5 × 1,10.
    const printed = it.quantity > 1 && hasPrintedCount(rows[it.row] ?? '', it.quantity, r.currency);
    const q = BigInt(it.quantity);
    const unitPrice = printed && total % q === 0n ? total / q : total;
    // Else a unit price printed before the total: the count is the ratio.
    const ratio = unitPrice === total ? unitBefore(rows[it.row] ?? '', total, r.currency) : null;
    if (ratio !== null)
      return { label: itemLabel(it.label, rows[it.row] ?? '', r.currency), ...ratio, total };
    return {
      label: itemLabel(it.label, rows[it.row] ?? '', r.currency),
      quantity: unitPrice === total ? 1 : it.quantity,
      unitPrice,
      total,
    };
  });

  let total = amountOf('the total', totalRow);
  let subtotal = subtotalRow === null ? null : amountOf('the subtotal', subtotalRow);
  let tax = taxRow === null ? 0n : amountOf('the tax', taxRow);
  const tip = tipRow === null ? 0n : amountOf('the tip', tipRow);
  const sum = () => items.reduce((a, it) => a + it.total, 0n);

  // The last "item" is the subtotal when it is the sum of the items above it and only then
  // the receipt adds up ("Tam tinh 265.000" listed as an item).
  const last = items.at(-1);
  const lastRow = priced.at(-1)?.row;
  if (subtotal === null && last !== undefined && lastRow !== undefined && items.length >= 3) {
    const above = sum() - last.total;
    if (last.total === above && above + tax + tip === total && sum() + tax + tip !== total) {
      items.pop();
      priced.pop();
      subtotal = above;
      dropped.push(
        `Row "${rows[lastRow]}" is the sum of the items above it: read as the subtotal.`,
      );
    }
  }
  // A tax the total already includes ("VAT included 2,44") is not added to it.
  if (tax > 0n && sum() + tip === total && sum() + tax + tip !== total) {
    dropped.push(`Row "${rows[taxRow ?? 0]}" is already in the total: not added as the tax.`);
    tax = 0n;
  }
  // When the total the model chose does not add up (it took the cash given, "Pagamento
  // contante 30,00"), the total is the first row below the items that does.
  const due = sum() + tax + tip;
  if (due !== total && priced.length > 0) {
    const from = Math.max(
      ...priced.map((p) => p.row),
      subtotalRow ?? -1,
      taxRow ?? -1,
      tipRow ?? -1,
    );
    for (let i = from + 1; i < rows.length; i++) {
      const row = rows[i] ?? '';
      if (special.has(i) || SUBTOTAL_LABEL.test(row) || printedDate([row], r.currency) !== null)
        continue;
      if (rowAmount(row, r.currency) === due) {
        dropped.push(`Row "${row}" adds up to the items: read as the total.`);
        total = due;
        break;
      }
    }
  }

  const receipt: Receipt = {
    merchant: printedMerchant(r.merchant, rows.slice(0, llmItems[0]?.row ?? rows.length)),
    date: printedDate(rows, r.currency) ?? r.date,
    currency: r.currency,
    items,
    total,
    warnings: [],
  };
  if (subtotal !== null) receipt.subtotal = subtotal;
  if (tax > 0n) receipt.tax = tax;
  if (tip > 0n) receipt.tip = tip;
  if (!z.iso.date().safeParse(receipt.date).success)
    errors.push(`date: "${r.date}" is not a date in the format YYYY-MM-DD`);

  const checked = z.safeEncode(ReceiptSchema, receipt);
  if (!checked.success) errors.push(z.prettifyError(checked.error));
  if (errors.length > 0) return { ok: false, error: errors.join('\n'), partial: readable(receipt) };
  receipt.warnings = [...dropped, ...receiptWarnings(receipt)];
  return { ok: true, receipt };
}

/**
 * The fields of a failed receipt that are valid on their own, for the pre-filled manual form:
 * an amount that could not be read (0, or a total that is not positive) or a bad date is left
 * out, never sent as a value (the API response refuses it).
 */
function readable(receipt: Receipt): Partial<Receipt> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(receipt)) {
    const field = ReceiptSchema.shape[key as keyof typeof ReceiptSchema.shape];
    if (value !== undefined && z.safeEncode(field, value as never).success) out[key] = value;
  }
  return out as Partial<Receipt>;
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
