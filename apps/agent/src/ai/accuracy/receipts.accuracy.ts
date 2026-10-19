import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiResult, Receipt } from '@kitty/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiService, type AiServiceHandle } from '../ai-service.js';
import type { AiEngine } from '../engine.js';
import { createQvacEngine } from '../qvac-engine.js';
import { loadCases, sameText, type Case, type TextKind, type Verdict } from './compare.js';

// pnpm ai:test: the app's receipt OCR (ai-service extractReceipt: QVAC OCR + Qwen3 rows +
// code for the amounts) on every fixture with an expected/<name>.json, field by field.
// Amounts, date and currency: exact after normalization (minor units, ISO date, ISO code).
// Merchant and item labels: normalized text, then the Qwen3 judge (compare.ts).
// Items are compared by position. Every comparison and every judge decision goes to
// .ai-test/report.md at the repo root (gitignored).

const REPORT_DIR = fileURLToPath(new URL('../../../../../.ai-test/', import.meta.url));

interface Row {
  receipt: string;
  field: string;
  expected: string;
  got: string;
  pass: boolean;
  via: 'exact' | Verdict['via'];
  judge?: string;
}
const rows: Row[] = [];
const extractions: {
  receipt: string;
  ok: boolean;
  attempts: number;
  ms: number;
  error?: string;
}[] = [];

const show = (v: unknown) => (v === undefined || v === null ? 'null' : JSON.stringify(String(v)));
const fail = (r: Row) =>
  `[${r.receipt}] ${r.field}: expected ${r.expected}, got ${r.got}` +
  (r.via === 'judge' ? ` (judge said: ${r.judge ?? '?'})` : '');

function exact(receipt: string, field: string, want: unknown, got: unknown) {
  const row: Row = {
    receipt,
    field,
    expected: show(want),
    got: show(got),
    pass: show(want) === show(got),
    via: 'exact',
  };
  rows.push(row);
  expect(row.pass, fail(row)).toBe(true);
}

let engine: AiEngine;
let ai: AiServiceHandle;

async function text(
  receipt: string,
  field: string,
  kind: TextKind,
  want: string | null,
  got: unknown,
) {
  if (want === null || typeof got !== 'string' || got.trim() === '') {
    exact(receipt, field, want, got);
    return;
  }
  const v = await sameText(engine, kind, want, got);
  const row: Row = {
    receipt,
    field,
    expected: show(want),
    got: show(got),
    pass: v.equivalent,
    via: v.via,
    ...(v.raw !== undefined && { judge: v.raw }),
  };
  rows.push(row);
  expect(row.pass, fail(row)).toBe(true);
}

beforeAll(async () => {
  engine = createQvacEngine();
  ai = createAiService({ engine });
  await ai.loaded;
  if (ai.status() !== 'ready') throw new Error(`on-device AI did not load: ${ai.error()}`);
});

afterAll(() => writeReport());

describe.each(loadCases())('$id', (c: Case) => {
  const e = c.expected;
  let result: AiResult<Receipt>;
  let got: Partial<Receipt> = {};

  beforeAll(async () => {
    result = await ai.extractReceipt(new Uint8Array(readFileSync(c.image)));
    got = result.ok ? result.data : result.partial;
    extractions.push({
      receipt: c.id,
      ok: result.ok,
      attempts: result.attempts,
      ms: result.latencyMs,
      ...(!result.ok && { error: result.error }),
    });
  });

  it('extraction gives a valid receipt', () => {
    expect(result.ok, `[${c.id}] no valid receipt: ${result.ok ? '' : result.error}`).toBe(true);
  });
  it('merchant', () => text(c.id, 'merchant', 'merchant', e.merchant, got.merchant));
  it('date', () => exact(c.id, 'date', e.date, got.date));
  it('currency', () => exact(c.id, 'currency', e.currency, got.currency));
  it('total', () => exact(c.id, 'total', e.total, got.total));
  it('subtotal', () => exact(c.id, 'subtotal', e.subtotal, got.subtotal));
  it('tax', () => exact(c.id, 'tax', e.tax, got.tax));
  it('tip', () => exact(c.id, 'tip', e.tip, got.tip));
  it('item count', () => exact(c.id, 'items.length', e.items.length, got.items?.length ?? 0));
  e.items.forEach((want, i) => {
    const item = () => got.items?.[i];
    it(`items[${i}].label`, () =>
      text(c.id, `items[${i}].label`, 'label', want.label, item()?.label));
    it(`items[${i}].quantity`, () =>
      exact(c.id, `items[${i}].quantity`, want.quantity, item()?.quantity));
    it(`items[${i}].unitPrice`, () =>
      exact(c.id, `items[${i}].unitPrice`, want.unitPrice, item()?.unitPrice));
    it(`items[${i}].total`, () => exact(c.id, `items[${i}].total`, want.total, item()?.total));
  });
});

/** Field category of a row: "items[3].total" → "items[].total". */
const category = (field: string) => field.replace(/\[\d+\]/u, '[]');

function writeReport() {
  const pass = rows.filter((r) => r.pass).length;
  const byCat = new Map<string, { pass: number; fail: number }>();
  for (const r of rows) {
    const k = category(r.field);
    const s = byCat.get(k) ?? { pass: 0, fail: 0 };
    s[r.pass ? 'pass' : 'fail']++;
    byCat.set(k, s);
  }
  const byReceipt = new Map<string, { pass: number; fail: number }>();
  for (const r of rows) {
    const s = byReceipt.get(r.receipt) ?? { pass: 0, fail: 0 };
    s[r.pass ? 'pass' : 'fail']++;
    byReceipt.set(r.receipt, s);
  }
  const cell = (s: string) => s.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
  const md = [
    '# pnpm ai:test report',
    '',
    `${new Date().toISOString()}: ${pass}/${rows.length} field comparisons passed, ` +
      `${extractions.filter((x) => x.ok).length}/${extractions.length} receipts extracted.`,
    '',
    '## By field',
    '',
    '| Field | Pass | Fail |',
    '|---|---|---|',
    ...[...byCat].map(([k, s]) => `| ${k} | ${s.pass} | ${s.fail} |`),
    '',
    '## By receipt',
    '',
    '| Receipt | Extracted | Attempts | ms | Pass | Fail |',
    '|---|---|---|---|---|---|',
    ...extractions.map((x) => {
      const s = byReceipt.get(x.receipt) ?? { pass: 0, fail: 0 };
      return `| ${x.receipt} | ${x.ok ? 'yes' : `no: ${cell(x.error ?? '')}`} | ${x.attempts} | ${x.ms} | ${s.pass} | ${s.fail} |`;
    }),
    '',
    '## Failures',
    '',
    '| Receipt | Field | Expected | Got | How |',
    '|---|---|---|---|---|',
    ...rows
      .filter((r) => !r.pass)
      .map(
        (r) => `| ${r.receipt} | ${r.field} | ${cell(r.expected)} | ${cell(r.got)} | ${r.via} |`,
      ),
    '',
    '## Judge decisions (every call)',
    '',
    '| Receipt | Field | Expected | Got | Verdict | Raw answer |',
    '|---|---|---|---|---|---|',
    ...rows
      .filter((r) => r.via === 'judge')
      .map(
        (r) =>
          `| ${r.receipt} | ${r.field} | ${cell(r.expected)} | ${cell(r.got)} | ${r.pass ? 'same' : 'different'} | ${cell(r.judge ?? '')} |`,
      ),
    '',
  ].join('\n');
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'report.md'), md);
  writeFileSync(
    join(REPORT_DIR, 'results.json'),
    `${JSON.stringify({ extractions, rows }, null, 2)}\n`,
  );
  console.log(`\nai:test report: ${join(REPORT_DIR, 'report.md')} (${pass}/${rows.length} passed)`);
}
