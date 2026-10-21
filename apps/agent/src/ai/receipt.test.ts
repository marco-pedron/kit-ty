import { describe, expect, it } from 'vitest';
import { ReceiptResultSchema } from '@kitty/shared';
import { printedDate, printedMerchant, rowAmount, rowLabel, toReceipt } from './receipt.js';

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
    // a tilted photo: the OCR split "75.000" in two blocks
    expect(rowAmount('Bia Saigon  3 X  25.000  75 .  000', 'VND')).toBe(75_000n);
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

describe('toReceipt, failed', () => {
  // A tilted photo once put "TOTAL VND" on a row of its own, without the amount: the error
  // went back to the model, and after 2 attempts the partial receipt carried total 0, which the
  // API response refused (VALIDATION_ERROR) instead of opening the pre-filled manual form.
  it('the partial keeps only the fields it could read: no total of 0', () => {
    const rows = ['PHO RESTAURANT HANOI', 'Pho bo  2 X 65.000  130.000', 'TOTAL VND'];
    const r = toReceipt(
      {
        ...base,
        currency: 'VND',
        items: [{ row: 1, label: 'Pho bo', quantity: 2 }],
        totalRow: 2,
      },
      rows,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/the total: row 2 "TOTAL VND" has no amount/);
    expect(r.partial.total).toBeUndefined();
    expect(r.partial.items).toEqual([
      { label: 'Pho bo', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    ]);
    expect(
      ReceiptResultSchema.safeEncode({
        ok: false,
        partial: r.partial,
        error: r.error,
        attempts: 2,
        latencyMs: 1,
      }).success,
    ).toBe(true);
  });
});

describe('toReceipt, item rows', () => {
  // The real model on the supermarket receipt photographed (rows straightened by blocksToLines):
  // it gave "Rice crackers" the row of the noodles, then the noodles the same row, so the
  // crackers got 2.70 and the noodles disappeared. Its own labels say which rows it meant.
  const rows = [
    'FRESH MARKET',
    '10/16/2026 18:05',
    'Bananas  0.73  kg  1.10/kg  0.80',
    'Water  1.5L  2 x 1.25  2.50',
    'Rice crackers  3.40',
    'Instant  noodles  3 X 0.90  2.70',
    'Subtotal  9,40',
    'Sales  tax  0.75',
    'TOTAL USD  10.15',
  ];
  const answer = {
    merchant: 'FRESH MARKET',
    date: '2026-10-16',
    currency: 'USD',
    items: [
      { row: 2, label: 'Bananas (0.73 kg)', quantity: 1 },
      { row: 3, label: 'Water (1.5L)', quantity: 2 },
      { row: 5, label: 'Rice crackers', quantity: 1 },
      { row: 5, label: 'Instant noodles', quantity: 3 },
      { row: 8, label: 'TOTAL USD', quantity: 1 },
    ],
    subtotalRow: 6,
    taxRow: 7,
    tipRow: null,
    totalRow: 8,
  };

  it('an item on a row that does not carry its label goes to the one row that does', () => {
    const r = toReceipt(answer, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.items.map((it) => [it.label, it.total])).toEqual([
      ['Bananas (0.73 kg)', 80n],
      ['Water (1.5L)', 250n],
      ['Rice crackers', 340n],
      ['Instant noodles', 270n],
    ]);
    expect(r.receipt.warnings).toEqual(['Row "TOTAL USD  10.15" is the total, not an item.']);
  });

  it('keeps the row the model gave when the label is on no row, or on several', () => {
    const vague = {
      ...answer,
      items: [
        { row: 4, label: 'Crackers di riso', quantity: 1 },
        { row: 5, label: 'Instant noodles', quantity: 3 },
      ],
    };
    const r = toReceipt(vague, rows);
    expect(r.ok && r.receipt.items.map((it) => it.total)).toEqual([340n, 270n]);
  });
});

describe('rowAmount, OCR damage to numbers', () => {
  it('reads a decimal mark the OCR lost at the end of the row', () => {
    expect(rowAmount('Tip  0  80', 'EUR')).toBe(80n);
    expect(rowAmount('Tip  4  50', 'USD')).toBe(450n);
    // no decimals: still a lost thousands dot, never a decimal mark
    expect(rowAmount('Tra  xanh  10  000', 'VND')).toBe(10_000n);
  });

  it('reads the letter O inside a number as a zero, never inside a word', () => {
    expect(rowAmount('Pho  bo  tai  ~  65.000  130  00o', 'VND')).toBe(130_000n);
    expect(rowAmount('BONO  5,00', 'EUR')).toBe(500n);
  });

  it('with decimals, the price is the last amount with its decimals', () => {
    // a VAT code "C" read as "0"
    expect(rowAmount('ACQUA  NAT  6XI , 5L  2,34  0', 'EUR')).toBe(234n);
    expect(rowAmount('LATTE  INTERO  IL  2 X  1,29  2 ,58', 'EUR')).toBe(258n);
  });

  it('a count written with * is a count, not a price', () => {
    expect(rowAmount('Ketchup *2  OMAGGIO', 'EUR')).toBeNull();
  });
});

describe('toReceipt, quantities', () => {
  const rows = [
    'SHOP',
    'MENU  CLASSIC  8 , 90  17,80',
    'YOGURT  GRECO  0 , 89  2 ,67',
    'Nem  ran  1 X  45 .000  45 .000',
    'ACQUA  NAT . 6X1 , 5L  2,34',
    'PANE  COMUNE  0,412 kg X 3,20 EUR/kg  1,32',
    'Birra  media  5,50',
    'TOTALE  31,00',
  ];
  const item = (row: number, label: string, quantity = 1) => ({ row, label, quantity });

  it('a unit price before the total gives the count when the OCR lost the "q x"', () => {
    const r = toReceipt(
      { ...base, totalRow: 7, items: [item(1, 'Menu Classic'), item(2, 'Yogurt greco')] },
      rows,
    );
    expect(r.ok && r.receipt.items).toEqual([
      { label: 'Menu Classic', quantity: 2, unitPrice: 890n, total: 1780n },
      { label: 'Yogurt greco', quantity: 3, unitPrice: 89n, total: 267n },
    ]);
  });

  it('reads "q x unit" with OCR spaces in the unit', () => {
    const r = toReceipt(
      { ...base, currency: 'VND', totalRow: 7, items: [item(3, 'Nem ran')] },
      rows,
    );
    expect(r.ok && r.receipt.items).toEqual([
      { label: 'Nem ran', quantity: 1, unitPrice: 45_000n, total: 45_000n },
    ]);
  });

  it('a pack size or a weight is not a count, even when the model says so', () => {
    const r = toReceipt(
      { ...base, totalRow: 7, items: [item(4, 'Acqua nat', 6), item(5, 'Pane', 412)] },
      rows,
    );
    expect(r.ok && r.receipt.items.map((it) => [it.quantity, it.unitPrice, it.total])).toEqual([
      [1, 234n, 234n],
      [1, 132n, 132n],
    ]);
  });

  it('a single amount stays one item: "Birra media 5,50" is not 5 × 1,10', () => {
    const r = toReceipt({ ...base, totalRow: 7, items: [item(6, 'Birra media', 5)] }, rows);
    expect(r.ok && r.receipt.items).toEqual([
      { label: 'Birra media', quantity: 1, unitPrice: 550n, total: 550n },
    ]);
  });
});

describe('rowLabel', () => {
  it.each([
    ['Pho  bo  2 X 65.000  130.000', 'VND', 'Pho bo'],
    ['Nuoc mia  2 X 10.000  20.000', 'VND', 'Nuoc mia'],
    ['Instant  noodles  3 X 0.90  2.70', 'USD', 'Instant noodles'],
    ['Bananas  0.73  kg  @  1.10/kg  0.80', 'USD', 'Bananas 0.73 kg'],
    ['2 x MENU CLASSIC L   8,90  17,80', 'EUR', 'MENU CLASSIC L'],
    ['X NUGGETS  9PZ  5,20', 'EUR', 'NUGGETS 9PZ'],
    ['LATTE  INTERO  1L  2 X  1,29  2 ,58 A', 'EUR', 'LATTE INTERO 1L'],
    ['ACQUA  NAT . 6X1 , 5L  2,34', 'EUR', 'ACQUA NAT . 6X1,5L'],
    ['0,734 kg  2 ,49  EUR/kg', 'EUR', '0,734 kg'],
  ] as const)('%s → %s', (row, currency, label) => expect(rowLabel(row, currency)).toBe(label));
});

describe('printedMerchant', () => {
  const header = ['PIZZERIA  VESUVIO', '18/10/2026  14:10'];
  it("keeps the model's name when the header prints it", () => {
    expect(printedMerchant('Pizzeria Vesuvio', header)).toBe('Pizzeria Vesuvio');
  });
  it('takes the whole row when the model gave part of it', () => {
    expect(printedMerchant('VESUVIO', header)).toBe('PIZZERIA VESUVIO');
  });
  it('a name the header does not print (made up, or an item) is the first header row', () => {
    expect(printedMerchant('Banh Mi Shop', ['QUAN  BUN  CHA', '07/10/2026  14:42'])).toBe(
      'QUAN BUN CHA',
    );
  });
  it('never takes the date row', () => {
    expect(printedMerchant('Corner shop', ['07/10/2026  14:42', 'CORNER  GROCERY'])).toBe(
      'CORNER GROCERY',
    );
  });
});

describe('toReceipt, text read from the rows', () => {
  const rows = [
    'CAFE  PHO  CO',
    '30/10/2026  10:56',
    'Ca  phe  den  24.000',
    'Tra  da  2 X 7.000  14.000',
    'TOTAL  VND  38.000',
  ];
  const answer = {
    ...base,
    merchant: 'Nuoc mia',
    currency: 'VND',
    totalRow: 4,
    items: [
      { row: 2, label: 'phe', quantity: 1 },
      { row: 3, label: 'Tra da 14.000', quantity: 2 },
    ],
  };
  it('a shortened label or one with prices is the name printed on the row', () => {
    const r = toReceipt(answer, rows);
    expect(r.ok && r.receipt.items.map((it) => it.label)).toEqual(['Ca phe den', 'Tra da']);
  });
  it('a merchant that is not printed above the items is the first header row', () => {
    const r = toReceipt(answer, rows);
    expect(r.ok && r.receipt.merchant).toBe('CAFE PHO CO');
  });
});

describe('toReceipt, which rows are items', () => {
  // A cluttered fast-food receipt as the OCR reads it photographed: the model lists the order
  // number, the payment and the change as items, and takes the cash given as the total.
  const rows = [
    'BURGER  STATION',
    '17-10-2026  13:27',
    '247',
    'MENU  CLASSIC  8 , 90  17,80',
    'X NUGGETS  9PZ  5,20',
    'x GELATO CARAMELLO  1,90  3,80',
    '0,734 kg  2 ,49  EUR/kg',
    'TOTALE COMPLESSIVO  26 ,80',
    'di  cui IVA  108  2 ,44',
    'Pagamento contante  30,00',
    'Resto  3 ,20',
  ];
  const item = (row: number, label: string) => ({ row, label, quantity: 1 });
  const answer = {
    ...base,
    totalRow: 9,
    items: [
      item(2, '247'),
      item(3, 'MENU CLASSIC'),
      item(4, 'NUGGETS'),
      item(5, 'GELATO CARAMELLO'),
      item(6, 'Banane'),
      item(10, 'Resto'),
    ],
  };

  it('keeps the products, drops what names no product and what is after the total', () => {
    const r = toReceipt(answer, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.items).toEqual([
      { label: 'MENU CLASSIC', quantity: 2, unitPrice: 890n, total: 1780n },
      { label: 'NUGGETS 9PZ', quantity: 1, unitPrice: 520n, total: 520n },
      { label: 'GELATO CARAMELLO', quantity: 2, unitPrice: 190n, total: 380n },
    ]);
    expect(r.receipt.warnings).toEqual([
      'Row "247" names no product, not an item.',
      'Row "0,734 kg  2 ,49  EUR/kg" names no product, not an item.',
      'Row "Resto  3 ,20" is after the total, not an item.',
      'Row "TOTALE COMPLESSIVO  26 ,80" adds up to the items: read as the total.',
    ]);
  });

  it("the total is the first row below the items that adds up, when the model's does not", () => {
    const r = toReceipt(answer, rows);
    expect(r.ok && r.receipt.total).toBe(2680n);
  });

  it('a "subtotal" above an item is not one, and stays an item when the model listed it', () => {
    const r = toReceipt({ ...answer, totalRow: 7, subtotalRow: 3 }, rows);
    expect(r.ok && r.receipt.subtotal).toBeUndefined();
    expect(r.ok && r.receipt.items.map((it) => it.total)).toEqual([1780n, 520n, 380n]);
    expect(r.ok && r.receipt.warnings).toContain(
      'Row "MENU  CLASSIC  8 , 90  17,80" is above an item: not the subtotal.',
    );
  });

  it('a tax printed after the total is VAT already included, not added', () => {
    const r = toReceipt({ ...answer, totalRow: 7, taxRow: 8 }, rows);
    expect(r.ok && r.receipt.tax).toBeUndefined();
    expect(r.ok && r.receipt.total).toBe(2680n);
    expect(r.ok && r.receipt.warnings).toContain(
      'Row "di  cui IVA  108  2 ,44" is after the total: not added as the tax.',
    );
  });
});

describe('toReceipt, subtotal and tax the model listed as items', () => {
  // A Vietnamese bill: "Tam tinh" (subtotal) and "Thue VAT 8%" listed as items.
  const rows = [
    'NHA  HANG  PHO  36',
    'Ngay:  17/10/2026',
    'Pho  bo tai  2 x 65.000  130 . 000',
    'Bia  Sai  Gon  3 x 25.000  75.000',
    'Tra  da  3 x 5.000  15.000',
    'Nem  ran  1 X  45 .000  45 .000',
    'Tam  tinh  265 . 000',
    'Thue  VAT  88  21.200',
    'TONG  CONG  (VND)  286 .200',
    'Tien  khach  dua  300 . 000',
  ];
  const answer = {
    ...base,
    currency: 'VND',
    totalRow: 8,
    items: [2, 3, 4, 5, 6, 7, 9].map((row) => ({ row, label: rows[row] ?? '', quantity: 1 })),
  };

  it('reads the tax by its name and the subtotal as the sum of the items above it', () => {
    const r = toReceipt(answer, rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.items.map((it) => [it.label, it.quantity, it.unitPrice, it.total])).toEqual([
      ['Pho bo tai', 2, 65_000n, 130_000n],
      ['Bia Sai Gon', 3, 25_000n, 75_000n],
      ['Tra da', 3, 5_000n, 15_000n],
      ['Nem ran', 1, 45_000n, 45_000n],
    ]);
    expect(r.receipt).toMatchObject({ subtotal: 265_000n, tax: 21_200n, total: 286_200n });
    expect(r.receipt.warnings).toEqual([
      'Row "Thue  VAT  88  21.200" read as the tax.',
      'Row "Tien  khach  dua  300 . 000" is after the total, not an item.',
      'Row "Tam  tinh  265 . 000" is the sum of the items above it: read as the subtotal.',
    ]);
  });

  it('an item equal to the sum of the ones above is still an item when the total says so', () => {
    const r = toReceipt(
      {
        ...base,
        totalRow: 4,
        items: [1, 2, 3].map((row) => ({ row, label: `Item ${row}`, quantity: 1 })),
      },
      ['SHOP', 'Pane  5,00', 'Latte  5,00', 'Vino  10,00', 'TOTALE  20,00'],
    );
    expect(r.ok && r.receipt.items.map((it) => it.total)).toEqual([500n, 500n, 1000n]);
    expect(r.ok && r.receipt.subtotal).toBeUndefined();
  });

  it('a tax the total already includes is not added', () => {
    const r = toReceipt(
      {
        ...base,
        totalRow: 3,
        taxRow: 2,
        items: [{ row: 1, label: 'Pasta', quantity: 1 }],
      },
      ['SHOP', 'Pasta  10,00', 'VAT included  1,82', 'TOTAL  10,00'],
    );
    expect(r.ok && r.receipt.tax).toBeUndefined();
    expect(r.ok && r.receipt.warnings).toContain(
      'Row "VAT included  1,82" is already in the total: not added as the tax.',
    );
  });
});
