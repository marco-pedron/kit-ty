import type { AiResult, MemberId, Receipt, SplitProposal } from '@kitty/shared';
import type { AiService } from '../ai/types.js';
import { assertFakesOn } from './guard.js';

// DEV ONLY (KITTY_FAKES=1): stands in for QVAC until task A4. It never reads the image or the
// sentence: it returns the demo dinner (SPEC §15) after a delay. /state reports ai.fake.

export const DEMO_RECEIPT: Receipt = {
  merchant: 'Pho restaurant, Hanoi',
  date: '2026-10-17',
  currency: 'VND',
  items: [
    { label: 'Pho bo x2', quantity: 2, unitPrice: 65_000n, total: 130_000n },
    { label: 'Bia Saigon x3', quantity: 3, unitPrice: 25_000n, total: 75_000n },
    { label: 'Water', quantity: 3, unitPrice: 10_000n, total: 30_000n },
  ],
  subtotal: 235_000n,
  tip: 20_000n,
  total: 255_000n,
  warnings: [],
};

// "Bob and I the pho, Charlie only beers, water for all three" → 3.09 / 3.09 / 3.50.
export const DEMO_SENTENCE = 'Bob and I had the pho, Charlie only beers, water for all three';
export const DEMO_SPLIT: SplitProposal = {
  assignments: [
    { itemIndex: 0, members: ['alice', 'bob'] },
    { itemIndex: 1, members: ['charlie'] },
    { itemIndex: 2, members: ['alice', 'bob', 'charlie'] },
  ],
  unassigned: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeAi(opts: { delayMs?: number } = {}): AiService {
  assertFakesOn('FakeAi');
  const delayMs = opts.delayMs ?? 2_000;
  return {
    status: () => 'ready',
    async extractReceipt(): Promise<AiResult<Receipt>> {
      await sleep(delayMs);
      return { ok: true, data: DEMO_RECEIPT, attempts: 1, latencyMs: delayMs };
    },
    async proposeSplit(_receipt: Receipt, members: MemberId[]): Promise<AiResult<SplitProposal>> {
      await sleep(delayMs);
      const known = DEMO_SPLIT.assignments.every((a) =>
        a.members.every((m) => members.includes(m)),
      );
      return known
        ? { ok: true, data: DEMO_SPLIT, attempts: 1, latencyMs: delayMs }
        : {
            ok: false,
            partial: { unassigned: DEMO_SPLIT.assignments.map((a) => a.itemIndex) },
            error: 'fake AI: the demo split names a traveler who is not active in this trip',
            attempts: 1,
            latencyMs: delayMs,
          };
    },
  };
}
