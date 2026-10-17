import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MemberId, Receipt } from '@kitty/shared';
import { createAiService } from './ai-service.js';
import { createQvacEngine } from './qvac-engine.js';

// pnpm ai:eval (task A4): the real on-device models on the receipt fixtures. A receipt passes
// with at most 1 manual correction (date, currency, total, tax, tip, or one item's numbers;
// labels and merchant are free text and not counted); the demo sentences must give the demo
// split exactly. Run it with the network off: pnpm ai:eval:offline.
// AI_EVAL_SET=hard (pnpm ai:eval:hard) runs the cluttered receipts of infra/fixtures/receipts/hard/
// instead: a stress test, not a gate (failures there are findings, not regressions).

const set = process.env.AI_EVAL_SET ?? '';
if (!/^[a-z0-9-]*$/.test(set)) throw new Error(`AI_EVAL_SET must be a folder name, got "${set}"`);
const dir = fileURLToPath(
  new URL(`../../../../infra/fixtures/receipts/${set ? `${set}/` : ''}`, import.meta.url),
);
type ExpectedItem = { quantity: number; unitPrice: string; total: string };
type Expected = {
  date: string;
  currency: string;
  items: ExpectedItem[];
  tax: string | null;
  tip: string | null;
  total: string;
};
const spec = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8')) as {
  receipts: Record<string, Expected>;
  split: {
    receipt: string;
    payer: MemberId;
    members: MemberId[];
    sentences: string[];
    assignments: { itemIndex: number; members: MemberId[] }[];
  };
  hostile: { receipt: string; payer: MemberId; members: MemberId[]; sentences: string[] };
};

function corrections(got: Receipt, want: Expected): string[] {
  const c: string[] = [];
  const s = (n: bigint | undefined) => (n === undefined ? null : n.toString());
  if (got.date !== want.date) c.push(`date ${got.date} ≠ ${want.date}`);
  if (got.currency !== want.currency) c.push(`currency ${got.currency} ≠ ${want.currency}`);
  if (s(got.total) !== want.total) c.push(`total ${s(got.total)} ≠ ${want.total}`);
  if (s(got.tax) !== want.tax) c.push(`tax ${s(got.tax)} ≠ ${want.tax}`);
  if (s(got.tip) !== want.tip) c.push(`tip ${s(got.tip)} ≠ ${want.tip}`);
  const n = Math.max(got.items.length, want.items.length);
  for (let i = 0; i < n; i++) {
    const g = got.items[i];
    const w = want.items[i];
    const gs = g ? `${g.quantity}×${g.unitPrice}=${g.total}` : 'missing';
    const ws = w ? `${w.quantity}×${w.unitPrice}=${w.total}` : 'extra';
    if (gs !== ws) c.push(`item ${i} ${gs} ≠ ${ws}`);
  }
  return c;
}

const ai = createAiService({
  engine: createQvacEngine(),
  log: { info: (m) => console.log(`▸ ${m}`), error: (m) => console.error(`✖ ${m}`) },
});
await ai.loaded;
if (ai.status() !== 'ready') process.exit(1);

let failed = 0;
const extracted = new Map<string, Receipt>();
for (const [name, want] of Object.entries(spec.receipts)) {
  const r = await ai.extractReceipt(new Uint8Array(readFileSync(`${dir}${name}.png`)));
  if (!r.ok) {
    failed++;
    console.log(
      `✖ ${name}: no valid Receipt after ${r.attempts} attempts (${r.latencyMs} ms): ${r.error}`,
    );
    continue;
  }
  extracted.set(name, r.data);
  const c = corrections(r.data, want);
  const pass = c.length <= 1;
  if (!pass) failed++;
  console.log(
    `${pass ? '✓' : '✖'} ${name}: ${r.attempts} attempt(s), ${r.latencyMs} ms, ${c.length} correction(s)` +
      (c.length ? `: ${c.join('; ')}` : '') +
      (r.data.warnings.length ? ` | warnings: ${r.data.warnings.join(' ')}` : ''),
  );
  console.log(`   ${r.data.items.map((it) => it.label).join(' | ')}`);
}

const s = spec.split;
const receipt = extracted.get(s.receipt);
for (const sentence of s.sentences) {
  if (receipt === undefined) {
    failed++;
    console.log(`✖ split "${sentence}": no receipt`);
    continue;
  }
  const r = await ai.proposeSplit(receipt, s.members, sentence, undefined, s.payer);
  const got = r.ok ? JSON.stringify(r.data.assignments) : null;
  const pass = r.ok && got === JSON.stringify(s.assignments) && r.data.unassigned.length === 0;
  if (!pass) failed++;
  console.log(
    `${pass ? '✓' : '✖'} split "${sentence}": ${r.latencyMs} ms, ${r.ok ? got : r.error}`,
  );
}

// A6, SPEC §13 #6: hostile sentences never produce a member or an item outside the request.
// Failing (ok: false, manual form) is fine; any assignment must stay within members and items.
const h = spec.hostile;
const hostileReceipt = extracted.get(h.receipt);
for (const sentence of h.sentences) {
  if (hostileReceipt === undefined) {
    failed++;
    console.log(`✖ hostile "${sentence}": no receipt`);
    continue;
  }
  const r = await ai.proposeSplit(hostileReceipt, h.members, sentence, undefined, h.payer);
  const outside = r.ok
    ? r.data.assignments.filter(
        (a) =>
          a.itemIndex >= hostileReceipt.items.length ||
          a.members.some((m) => !h.members.includes(m)),
      )
    : [];
  if (outside.length > 0) failed++;
  console.log(
    `${outside.length === 0 ? '✓' : '✖'} hostile "${sentence}": ${
      r.ok ? JSON.stringify(r.data.assignments) : `ok: false (${r.error.split('\n')[0]})`
    }`,
  );
}

console.log(failed === 0 ? '\nai:eval passed' : `\nai:eval: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
