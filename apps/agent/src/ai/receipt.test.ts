import { describe, expect, it } from 'vitest';
import { printedDate, rowAmount, toReceipt } from './receipt.js';

// toReceipt over OCR rows like a fast-food receipt: menu components and freebies printed
// under an item, without a price of their own.

const ROWS = [
  'BURGER STATION',
  'ORDINE N. 247',
  '2 x MENU CLASSIC L   8,90  17,80',
  '+ Patatine grandi',
  '+ Bibita 0,5L',
  '1 x NUGGETS 9PZ  5,20',
  '2 x GELATO CARAMELLO 1,90  3,80',
  'Ketchup x2  OMAGGIO',
  'TOTALE COMPLESSIVO  26,80',
  'di cui IVA 10%  2,44',
  'Pagamento contante  30,00',
  'Resto  3,20',
  '17-10-2026 13:27',
];

const base = {
  merchant: 'Burger Station',
  date: '2026-10-17',
  currency: 'EUR',
  subtotalRow: null,
  taxRow: null,
  tipRow: null,
  totalRow: 8,
};

// The model marks every line of the order as an item, the sub-lines too.
const allLines = [
  { row: 2, label: 'Menu Classic L', quantity: 2 },
  { row: 3, label: 'Patatine grandi', quantity: 1 },
  { row: 4, label: 'Bibita 0,5L', quantity: 1 },
  { row: 5, label: 'Nuggets 9pz', quantity: 1 },
  { row: 6, label: 'Gelato caramello', quantity: 2 },
  { row: 7, label: 'Ketchup', quantity: 2 },
];

describe('rowAmount', () => {
  it('ignores measures and counts, keeps the price', () => {
    expect(rowAmount('+ Bibita 0,5L', 'EUR')).toBeNull();
    expect(rowAmount('Ketchup x2  OMAGGIO', 'EUR')).toBeNull();
    expect(rowAmount('1 x NUGGETS 9PZ  5,20', 'EUR')).toBe(520n);
    expect(rowAmount('Bananas 0.73 kg  1.83', 'EUR')).toBe(183n);
    expect(rowAmount('Coca cola 33cl x2  5,00', 'EUR')).toBe(500n);
    expect(rowAmount('Pho bo  2 X 65.000  130.000', 'VND')).toBe(130_000n);
    expect(rowAmount('3 X 0.90  2.70', 'USD')).toBe(270n);
  });

  it('reads amounts with OCR spaces around the decimal mark or a lost thousands dot', () => {
    expect(rowAmount('Birra  media  6 ,00', 'EUR')).toBe(600n);
    expect(rowAmount('Subtotal  47 ,  00', 'EUR')).toBe(4700n);
    expect(rowAmount('Cappuccino  3 X  1,50  4, 50', 'EUR')).toBe(450n);
    expect(rowAmount('Tra  xanh  10  000', 'VND')).toBe(10_000n);
    expect(rowAmount('Com  tam  3 X 40.000  120.000', 'VND')).toBe(120_000n);
  });
});

describe('printedDate', () => {
  it('reads day/month/year, and month/day/year on USD receipts', () => {
    expect(printedDate(['PIZZERIA', '08/10/2026  07:35'], 'EUR')).toBe('2026-10-08');
    expect(printedDate(['DINER', '10/06/2026  15:29'], 'USD')).toBe('2026-10-06');
    expect(printedDate(['DINER', '13/10/2026'], 'USD')).toBe('2026-10-13');
    expect(printedDate(['17-10-2026 13:27'], 'EUR')).toBe('2026-10-17');
    expect(printedDate(['2026-10-17'], 'VND')).toBe('2026-10-17');
    expect(printedDate(['TOTAL EUR 45,00'], 'EUR')).toBeNull();
  });
});

describe('toReceipt', () => {
  it('drops item rows without a price, with a warning, and keeps the amounts as printed', () => {
    const r = toReceipt({ ...base, items: allLines }, ROWS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.items).toEqual([
      { label: 'Menu Classic L', quantity: 2, unitPrice: 890n, total: 1780n },
      { label: 'Nuggets 9pz', quantity: 1, unitPrice: 520n, total: 520n },
      { label: 'Gelato caramello', quantity: 2, unitPrice: 190n, total: 380n },
    ]);
    expect(r.receipt.total).toBe(2680n);
    expect(r.receipt.tax).toBeUndefined();
    expect(r.receipt.warnings).toEqual([
      'Row "+ Patatine grandi" has no price: not counted as an item.',
      'Row "+ Bibita 0,5L" has no price: not counted as an item.',
      'Row "Ketchup x2  OMAGGIO" has no price: not counted as an item.',
    ]);
  });

  it('still warns when the kept items do not add up to the total', () => {
    // the model misses the nuggets: 21,60 ≠ 26,80, said and not fixed
    const items = allLines.filter((it) => it.row !== 5);
    const r = toReceipt({ ...base, items }, ROWS);
    expect(r.ok && r.receipt.total).toBe(2680n);
    expect(r.ok && r.receipt.warnings).toContain(
      'Items + tax + tip = 21.60 EUR, but the total is 26.80 EUR. Check the lines.',
    );
  });

  it('takes the date from the rows, not from the model', () => {
    const r = toReceipt({ ...base, date: '2026-10-01', items: allLines }, ROWS);
    expect(r.ok && r.receipt.date).toBe('2026-10-17');
  });

  it('keeps a quantity only when the row prints it, and never takes the date row as an item', () => {
    const rows = [
      'BAR',
      '22/10/2026  15:49',
      'Birra media  5,50',
      'Coca cola  2 x 3,00  6,00',
      'TOTAL EUR  11,50',
    ];
    const items = [
      { row: 1, label: 'Date', quantity: 1 },
      { row: 2, label: 'Birra media', quantity: 5 },
      { row: 3, label: 'Coca cola', quantity: 2 },
    ];
    const r = toReceipt({ ...base, totalRow: 4, items }, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.items).toEqual([
      { label: 'Birra media', quantity: 1, unitPrice: 550n, total: 550n },
      { label: 'Coca cola', quantity: 2, unitPrice: 300n, total: 600n },
    ]);
    expect(r.receipt.warnings).toEqual(['Row "22/10/2026  15:49" is the date, not an item.']);
  });

  it('does not read a row without an amount as the tax', () => {
    const rows = ['SHOP', 'Pasta  1,00', 'TOTALE EUR  1,00', 'IVA  inclusa'];
    const items = [{ row: 1, label: 'Pasta', quantity: 1 }];
    const r = toReceipt({ ...base, taxRow: 3, totalRow: 2, items }, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.tax).toBeUndefined();
    expect(r.receipt.warnings).toEqual(['Row "IVA  inclusa" has no amount: not read as the tax.']);
  });

  it('is an error when no item row has a price', () => {
    const items = allLines.filter((it) => [3, 4, 7].includes(it.row));
    const r = toReceipt({ ...base, items }, ROWS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('item 0: row 3 "+ Patatine grandi" has no amount');
    expect(r.error).toContain('item 2: row 7 "Ketchup x2  OMAGGIO" has no amount');
  });
});
