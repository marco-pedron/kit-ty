import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActorId,
  AgentClient,
  LineView,
  Receipt,
  SplitAssignment,
  TripView,
} from '@kitty/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESPLORA, startStack, tipHeight, waitFor, type Stack } from './harness.js';

// B8: the demo of SPEC §16, steps 2-7, without the UI: through the agent API (SPEC §14.3) on
// the real regtest stack, with the real on-device AI on the photo of the dinner
// (infra/fixtures/receipts/vnd-dinner.png) and the sentence of the demo. IRREVERSIBLE: charlie is excluded and his channels
// closed; run `pnpm demo:reset` before the next run.

const LOG =
  process.env.KITTY_E2E_LOG ??
  fileURLToPath(new URL('../../../../infra/.out/logs/e2e-demo-processes.log', import.meta.url));
const SUMMARY = fileURLToPath(new URL('../../../../infra/.out/e2e-demo.json', import.meta.url));
const summary: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  summary[k] = v;
  mkdirSync(dirname(SUMMARY), { recursive: true });
  writeFileSync(
    SUMMARY,
    JSON.stringify(summary, (_, x) => (typeof x === 'bigint' ? `${x}` : x), 2),
  );
  console.log(`[e2e] ${k}: ${JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}` : x))}`);
};

/**
 * EXPERIMENT ln-1ch-swap (demo:reset:1ch): one channel per traveler, so one close in step 6, and
 * the fork's sweep runs on a timer (~130 s), so step 6 takes minutes.
 */
const ONE_CH = process.env.KITTY_RAIL_MODE === 'ln-1ch-swap';
const SEED_STATE =
  process.env.KITTY_SEED_STATE_FILE ??
  fileURLToPath(new URL('../../../../infra/.out/seed-state.json', import.meta.url));

/** The close of step 6 must confirm and sweep within this many blocks (B7: ~7, before: 11). */
const CLOSE_MAX_BLOCKS = 8;

let stack: Stack;
let api: Record<ActorId, AgentClient>;
let expenseId: string;
const before: Partial<Record<ActorId, TripView>> = {};

const debt = (s: TripView): LineView | undefined =>
  s.me?.debts.find((l) => l.expenseId === expenseId);
const state = (as: ActorId) => api[as].getState();

beforeAll(async () => {
  mkdirSync(dirname(LOG), { recursive: true });
  stack = await startStack({
    relayPort: Number(process.env.E2E_RELAY_PORT ?? 4400),
    agentPort: Number(process.env.E2E_AGENT_PORT ?? 4500),
    processLog: LOG,
  });
  api = {
    alice: stack.client('alice'),
    bob: stack.client('bob'),
    charlie: stack.client('charlie'),
    dave: stack.client('dave'),
  };
  for (const as of ['alice', 'bob', 'charlie'] as const) {
    before[as] = await waitFor(`${as}'s balance`, async () => {
      const s = await state(as);
      return s.me?.balance ? s : undefined;
    });
  }
  note('before', {
    alice: before.alice?.me?.balance,
    bob: before.bob?.me?.balance,
    charlie: before.charlie?.me?.balance,
  });
}, 120_000);

afterAll(async () => {
  await stack?.stop();
});

describe('B8 the demo of SPEC §16 on the regtest stack (irreversible)', () => {
  it('step 1: every traveler starts with 50.00 in the trip channel', () => {
    for (const as of ['alice', 'bob', 'charlie'] as const)
      expect(before[as]?.me?.balance?.tripOutboundCents).toBe(5000n);
  });

  const photo = readFileSync(
    fileURLToPath(new URL('../../../../infra/fixtures/receipts/vnd-dinner.png', import.meta.url)),
  );
  let receipt: Receipt;
  let assignments: SplitAssignment[];

  it('step 2: the AI on the device reads the photo of the receipt', async () => {
    await waitFor(
      'the on-device AI ready',
      async () => ((await state('alice')).ai.status === 'ready' ? true : undefined),
      120_000,
      1_000,
    );
    const ai = (await state('alice')).ai;
    expect(ai).toEqual({ status: 'ready', fake: false });
    const r = await api.alice.extractReceipt({
      image: { mimeType: 'image/png', dataBase64: photo.toString('base64') },
    });
    note('extract', r);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    receipt = r.data;
    expect(receipt).toMatchObject({ currency: 'VND', total: 255_000n, tip: 20_000n, warnings: [] });
    expect(receipt.items.map((it) => it.total)).toEqual([130_000n, 75_000n, 30_000n]);
  });

  it('step 2: the sentence gives the split; the ledger shares are 3.09 / 3.09 / 3.50', async () => {
    const r = await api.alice.proposeSplit({
      receipt,
      text: "Bob e io la pho, Charlie solo birre, l'acqua in tre",
    });
    note('split', r);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    assignments = r.result.data.assignments;
    const shares = Object.fromEntries((r.preview?.shares ?? []).map((x) => [x.member, x.cents]));
    expect(shares).toEqual({ alice: 309n, bob: 309n, charlie: 350n });
  });

  it('step 2: alice submits; the lines are 3.09 for bob and 3.50 for charlie', async () => {
    const t0 = Date.now();
    const expense = await api.alice.submitExpense({
      receipt,
      assignments,
      receiptImageSha256: createHash('sha256').update(photo).digest('hex'),
    });
    expenseId = expense.expenseId;
    const s = await state('alice');
    const credits = s.me?.credits.filter((l) => l.expenseId === expenseId) ?? [];
    const shares = Object.fromEntries(credits.map((l) => [l.debtor, l.cents]));
    note('submit', { expenseId, ms: Date.now() - t0, shares });
    expect(shares).toEqual({ bob: 309n, charlie: 350n });
  });

  let heightAtSubmit: number;

  it('step 4: charlie contests ("I only had water")', async () => {
    heightAtSubmit = await tipHeight();
    await waitFor('charlie sees the line', async () => {
      const l = debt(await state('charlie'));
      return l?.state === 'awaiting_decision' ? l : undefined;
    });
    const line = await api.charlie.decideLine({
      id: expenseId,
      decision: 'contest',
      reason: 'I only had water',
    });
    expect(line.state).toBe('contested');
  });

  it('step 3: bob does nothing; his agent pays 3.09 after the silent assent, no block mined', async () => {
    const t0 = Date.now();
    const line = await waitFor(
      "bob's line paid",
      async () => {
        const l = debt(await state('bob'));
        return l?.state === 'paid' ? l : undefined;
      },
      60_000,
    ).catch(async (e: unknown) => {
      // what the agents were doing, for the log
      for (const as of ['bob', 'alice', 'dave'] as const) {
        const s = await state(as);
        note(`diagnostics ${as}`, {
          line: as === 'bob' ? debt(s) : undefined,
          operations: s.operations.slice(0, 6),
        });
      }
      throw e;
    });
    expect(line.paidBy).toBe('debtor');
    expect(line.agent?.reason).toMatch(/3\.09/u);
    expect(line.proof?.rail).toBe('ln');
    // dave's agent serves the proofs: it sees PAYMENT_MADE at its next tick (1 s)
    const hash = line.proof?.rail === 'ln' ? line.proof.paymentHash : '';
    const proof = await waitFor("the proof of bob's payment", () =>
      api.bob.getProof({ paymentHash: hash }),
    );
    const blocks = (await tipHeight()) - heightAtSubmit;
    note('bob paid', { afterMs: Date.now() - t0, reason: line.agent?.reason, proof, blocks });
    expect(proof.verified).toBe(true);
    expect(proof.rail === 'ln' && Object.values(proof.checks).every((c) => c.ok)).toBe(true);
    expect(blocks).toBe(0);
    const bobAfter = await waitFor('bob at 46.91', async () => {
      const b = (await state('bob')).me?.balance;
      return b?.tripOutboundCents === 4691n ? b : undefined;
    });
    note('bob balance', bobAfter);
  });

  it('step 5: dave sees the dispute and upholds the line', async () => {
    const d = await waitFor('the dispute on dave', async () =>
      (await state('dave')).coordinator?.disputes.find(
        (x) => x.expenseId === expenseId && x.debtor === 'charlie',
      ),
    );
    expect(d.cents).toBe(350n);
    expect(d.reason).toBe('I only had water');
    const line = await api.dave.resolveDispute({
      expenseId,
      member: 'charlie',
      outcome: 'upheld',
      note: 'The photo shows the beers',
    });
    expect(line.state).toBe('due');
  });

  it(
    'step 6: charlie does not pay; dave covers 3.50 and excludes him',
    async () => {
      const t0 = Date.now();
      const def = await waitFor(
        "charlie's line overdue on dave",
        async () =>
          (await state('dave')).coordinator?.defaults.find(
            (x) => x.expenseId === expenseId && x.debtor === 'charlie',
          ),
        90_000,
      );
      note('overdue', { afterMs: Date.now() - t0, def });
      expect(def.coverable).toBe(true);
      // charlie's agent never paid it (payUpheldDisputes is false by default)
      expect(debt(await state('charlie'))?.state).toBe('overdue');

      const h0 = await tipHeight();
      const t1 = Date.now();
      const r = await api.dave.coverAndExclude({ expenseId, member: 'charlie' });
      const blocksMined = (await tipHeight()) - h0;
      note('cover and exclude', { ...r, ms: Date.now() - t1, blocksMined });

      expect(r.covered?.rail).toBe('ln');
      expect(r.closingTxids).toHaveLength(ONE_CH ? 1 : 2);
      expect(blocksMined).toBeLessThanOrEqual(CLOSE_MAX_BLOCKS);
      for (const txid of r.closingTxids) {
        const res = await fetch(`${ESPLORA}/tx/${txid}`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: { confirmed: boolean } }).status.confirmed).toBe(
          true,
        );
      }
      const proof = await api.alice.getProof({
        paymentHash: r.covered?.rail === 'ln' ? r.covered.paymentHash : '',
      });
      expect(proof.verified).toBe(true);
      expect(proof.rail === 'ln' && proof.paidBy).toBe('guarantee');

      const dave = await state('dave');
      const charlie = dave.members.find((m) => m.memberId === 'charlie');
      expect(charlie?.status).toBe('excluded');
      expect(charlie?.closingTxids).toEqual(r.closingTxids);
      const op = dave.coordinator?.members.find((m) => m.memberId === 'charlie');
      expect(op?.guaranteeUsedCents).toBe(350n);
      expect(op?.operatorCreditCents).toBe(350n);
    },
    ONE_CH ? 420_000 : undefined,
  );

  it("step 6: charlie's 50.00 come back to him on-chain", async () => {
    const was = before.charlie?.me?.balance;
    const b = await waitFor(
      "charlie's DUSD on-chain",
      async () => {
        const x = (await state('charlie')).me?.balance;
        return x && was && x.onchainCents === was.onchainCents + 5000n ? x : undefined;
      },
      90_000,
      2_000,
    );
    note('charlie balance', b);
    expect(b.tripOutboundCents).toBe(0n);
  });

  it('step 7: alice is reimbursed 6.59, 3.09 from bob and 3.50 guaranteed', async () => {
    const s = await waitFor('alice reimbursed', async () => {
      const x = await state('alice');
      const b = x.me?.balance;
      return b?.tripOutboundCents === 5659n ? x : undefined;
    });
    const credits = s.me?.credits.filter((l) => l.expenseId === expenseId) ?? [];
    const by = Object.fromEntries(credits.map((l) => [l.debtor, [l.state, l.paidBy, l.cents]]));
    note('alice', { balance: s.me?.balance, credits: by });
    expect(by).toEqual({
      bob: ['paid', 'debtor', 309n],
      charlie: ['guaranteed', 'guarantee', 350n],
    });
    expect(s.me?.owedToMeCents).toBe(0n);
  });

  it('B6: every traveler backed their node up to the relay, encrypted', async () => {
    const seed = JSON.parse(readFileSync(SEED_STATE, 'utf8')) as {
      pubkeys: Record<ActorId, string>;
    };
    const sizes = await waitFor(
      "a backup of every traveler's node on the relay",
      async () => {
        const out: Record<string, number> = {};
        // not dave: his node is never locked during the trip (B6)
        for (const a of ['alice', 'bob', 'charlie'] as const) {
          const res = await fetch(`${stack.relayUrl}/backups/${seed.pubkeys[a]}`);
          if (res.status !== 200) return undefined;
          out[a] = (await res.arrayBuffer()).byteLength;
        }
        return out;
      },
      60_000,
      2_000,
    );
    note('backups', sizes);
    for (const n of Object.values(sizes)) expect(n).toBeGreaterThan(10_000);
  });

  it('step 7: "Ledger verified" on every phone, same head on 4/4', async () => {
    const heads = await waitFor('the same head on 4/4', async () => {
      const all = await Promise.all((['alice', 'bob', 'charlie', 'dave'] as const).map(state));
      const h = all.map((x) => x.ledger);
      return h.every((x) => x.headHash === h[0]?.headHash) ? h : undefined;
    });
    note('ledger', heads);
    // L = 30.00 covers the demo: dave never opened liquidity (B9)
    const dave = await state('dave');
    expect(dave.operations.filter((o) => o.kind === 'opening_liquidity')).toEqual([]);
    for (const h of heads) {
      expect(h.chainValid).toBe(true);
      expect(h.validSignatures).toBe(h.events);
    }
  });
});
