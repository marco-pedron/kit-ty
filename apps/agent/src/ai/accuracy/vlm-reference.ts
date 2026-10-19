import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeBand, rowBands } from './png-rows.js';

// Draft expected values of the receipt fixtures, for the OCR accuracy suite (pnpm ai:test).
// Never read with the app's own pipeline (OCR_LATIN + Qwen3 over rows): that would be circular.
// - Fields the generators know (date, currency, items' quantity/unitPrice/total, tax, tip,
//   total) come from their expected.json: true by construction.
// - Fields they do not (merchant, item labels, subtotal) come from QVAC's vision model
//   SmolVLM2, which reads the image itself, then a person checks them against the image
//   (and marks a corrected field "manual" in `_source`).
// - SmolVLM2's transcription is also a cross-check of the generator's values: each one should
//   be printed. A miss is printed below, for a person to look at, never applied.
// A "-photo" receipt is the same print photographed: it copies its clean twin, unread.
//
// SmolVLM2 (500M) loops on a whole long receipt, so it reads one printed row at a time: the
// rows are found in the pixels (png-rows.ts), never with the app's OCR.
//
// Usage: pnpm --filter @kitty/agent exec tsx src/ai/accuracy/vlm-reference.ts [--force] [names…]
// Existing files are kept unless --force (they may carry manual corrections).

type Sdk = typeof import('@qvac/sdk');

const ROOT = fileURLToPath(new URL('../../../../../infra/fixtures/receipts/', import.meta.url));
const SETS = ['', 'simple/', 'hard/'];

type GenItem = { quantity: number; unitPrice: string; total: string };
type GenReceipt = {
  date: string;
  currency: string;
  items: GenItem[];
  tax: string | null;
  tip: string | null;
  total: string;
};

/** Minor units → the amount as these receipts print it ("38,50", "10.15", "255.000"). */
function printed(minor: string, currency: string): string {
  const group = (n: string, sep: string) => n.replace(/\B(?=(\d{3})+(?!\d))/gu, sep);
  if (currency === 'VND') return group(minor, '.');
  const n = minor.padStart(3, '0');
  const [whole, cents] = [n.slice(0, -2), n.slice(-2)];
  return currency === 'EUR' ? `${group(whole, '.')},${cents}` : `${group(whole, ',')}.${cents}`;
}

/** The date as printed: day/month/year, month/day/year in USD; "/" "-" or "." */
function printedDates(iso: string, currency: string): RegExp {
  const [y, m, d] = iso.split('-');
  const [a, b] = currency === 'USD' ? [m, d] : [d, m];
  return new RegExp(`${a}[/.-]${b}[/.-]${y}`, 'u');
}

/** One PNG per printed row of the image, written to `dir`. */
function rowImages(image: string, dir: string): string[] {
  const img = decodePng(readFileSync(image));
  return rowBands(img).map(([y0, y1], i) => {
    const file = join(dir, `${basename(image, '.png')}-${String(i).padStart(3, '0')}.png`);
    writeFileSync(file, encodeBand(img, y0, y1));
    return file;
  });
}

async function ask(sdk: Sdk, modelId: string, image: string, content: string): Promise<string> {
  const run = sdk.completion({
    modelId,
    stream: true,
    history: [{ role: 'user', content, attachments: [{ path: image }] }],
    generationParams: { temp: 0, seed: 42, predict: 120 },
  });
  const final = await run.final;
  return (final.contentText || final.raw.fullText).replace(/\s+/gu, ' ').trim();
}

const AMOUNT = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?/gu;

/**
 * The row of an item: the first row from `from` on that carries its printed total (and its
 * "q x unit" when q > 1). The label is that row without amounts, counts and VAT codes.
 */
function itemRow(rows: string[], it: GenItem, currency: string, from: number) {
  const total = printed(it.total, currency);
  const unit = new RegExp(
    `${it.quantity}\\s*[xX×]\\s*${esc(printed(it.unitPrice, currency))}`,
    'u',
  );
  for (let i = from; i < rows.length; i++) {
    const row = rows[i] ?? '';
    if (!row.includes(total) || (it.quantity > 1 && !unit.test(row))) continue;
    const label = row
      .replace(unit, ' ')
      .replace(/^\s*\d{1,3}\s*[xX×]\s+/u, '')
      .replace(new RegExp(`${esc(total)}(?:\\s+[A-C])?\\s*$`, 'u'), '')
      .replace(/\s+/gu, ' ')
      .trim();
    return { index: i, label: label === '' ? null : label };
  }
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter((a) => !a.startsWith('--')));

const sdk: Sdk = await import('@qvac/sdk');
const modelId = await sdk.loadModel({
  modelSrc: sdk.SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: { ctx_size: 4096, projectionModelSrc: sdk.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 },
});
const tmp = mkdtempSync(join(tmpdir(), 'kitty-rows-'));

const misses: string[] = [];
for (const set of SETS) {
  const dir = join(ROOT, set);
  const gen = (
    JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
      receipts: Record<string, GenReceipt>;
    }
  ).receipts;
  const outDir = join(dir, 'expected');
  mkdirSync(outDir, { recursive: true });
  const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'));
  // clean receipts first: a photo copies its clean twin
  pngs.sort(
    (a, b) => Number(a.includes('-photo')) - Number(b.includes('-photo')) || a.localeCompare(b),
  );
  for (const png of pngs) {
    const name = basename(png, '.png');
    const out = join(outDir, `${name}.json`);
    if ((only.size > 0 && !only.has(name)) || (existsSync(out) && !force)) continue;
    const g = gen[name];
    if (g === undefined) {
      misses.push(`${set}${name}: not in the generator's expected.json, skipped`);
      continue;
    }
    if (name.endsWith('-photo')) {
      const twin = JSON.parse(
        readFileSync(join(outDir, `${name.slice(0, -'-photo'.length)}.json`), 'utf8'),
      ) as Record<string, unknown>;
      const copy: Record<string, unknown> = { receipt: png, _derivedFrom: twin.receipt, ...twin };
      copy.receipt = png;
      delete copy._vlmRows;
      writeFileSync(out, `${JSON.stringify(copy, null, 2)}\n`);
      console.log(`${set}${name}: copied from ${String(twin.receipt)}`);
      continue;
    }

    const t0 = Date.now();
    const rows: string[] = [];
    for (const p of rowImages(join(dir, png), tmp))
      rows.push(
        await ask(sdk, modelId, p, 'Transcribe the text of this image exactly as printed.'),
      );
    const transcript = rows.join(' | ');
    const subRow = rows.find((r) => /sub\s*total|tam tinh/iu.test(r));
    const sub = subRow?.match(AMOUNT)?.at(-1) ?? null;
    let from = 0;
    const labels = g.items.map((it) => {
      const found = itemRow(rows, it, g.currency, from);
      if (found === null) return null;
      from = found.index + 1;
      return found.label;
    });

    const miss = (field: string, value: string) => {
      if (!transcript.includes(value))
        misses.push(`${set}${name} ${field}: generator ${value} not in the transcription`);
    };
    if (!printedDates(g.date, g.currency).test(transcript))
      misses.push(`${set}${name} date: ${g.date} not in the transcription`);
    if (!transcript.includes(g.currency))
      misses.push(`${set}${name} currency: ${g.currency} not printed in the transcription`);
    g.items.forEach((it, i) => {
      miss(`items[${i}].total`, printed(it.total, g.currency));
      if (it.quantity > 1)
        miss(`items[${i}].unitPrice`, `${it.quantity} x ${printed(it.unitPrice, g.currency)}`);
    });
    for (const k of ['tax', 'tip', 'total'] as const) {
      const v = g[k];
      if (v !== null) miss(k, printed(v, g.currency));
    }

    const subtotal = sub === null ? null : sub.replace(/[.,]/gu, '').replace(/^0+(?=\d)/u, '');
    const expected = {
      receipt: png,
      merchant: rows[0] || null,
      date: g.date,
      currency: g.currency,
      items: g.items.map((it, i) => ({ label: labels[i] ?? null, ...it })),
      subtotal,
      tax: g.tax,
      tip: g.tip,
      total: g.total,
      _source: {
        merchant: 'smolvlm2',
        date: 'generator',
        currency: 'generator',
        items: g.items.map(() => ({
          label: 'smolvlm2',
          quantity: 'generator',
          unitPrice: 'generator',
          total: 'generator',
        })),
        subtotal: 'smolvlm2',
        tax: 'generator',
        tip: 'generator',
        total: 'generator',
      },
      _vlmRows: rows,
    };
    writeFileSync(out, `${JSON.stringify(expected, null, 2)}\n`);
    console.log(
      `${set}${name}: ${Date.now() - t0} ms, merchant ${JSON.stringify(expected.merchant)}, labels ${JSON.stringify(expected.items.map((i) => i.label))}, subtotal ${subtotal}`,
    );
  }
}
await sdk.unloadModel({ modelId, clearStorage: false });
console.log(
  `\n${misses.length} generator value(s) not found in SmolVLM2's reading:\n${misses.join('\n')}`,
);
process.exit(0);
