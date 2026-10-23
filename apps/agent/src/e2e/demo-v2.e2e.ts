import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActorId,
  AgentClient,
  LineView,
  MemberId,
  Receipt,
  SplitAssignment,
  TripView,
} from '@kitty/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESPLORA, startStack, tipHeight, waitFor, type Stack } from './harness.js';

// pnpm e2e:demo:v2 (KITTY_REGISTRY=v2, 23/10): the demo driven by the registry v2, without the
// UI, through the agent API on the real regtest stack, with the real on-device AI. No
// coordinator: dave's node is only the LSP. Charlie contests, then withdraws by approving after
// seeing the line again (C3), and pays; at the end every member leaves, closing their own
// channels with the LSP, and the trip is closed. IRREVERSIBLE: run `pnpm demo:reset` first.

const LOG =
  process.env.KITTY_E2E_LOG ??
  fileURLToPath(new URL('../../../../infra/.out/logs/e2e-demo-v2-processes.log', import.meta.url));
const SUMMARY = fileURLToPath(new URL('../../../../infra/.out/e2e-demo-v2.json', import.meta.url));
const summary: Record<string, unknown> = {};
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}` : x));
const note = (k: string, v: unknown) => {
  summary[k] = v;
  mkdirSync(dirname(SUMMARY), { recursive: true });
  writeFileSync(SUMMARY, JSON.stringify(JSON.parse(json(summary)), null, 2));
  console.log(`[e2e] ${k}: ${json(v)}`);
};

/** A member's close must confirm and sweep within this many blocks (as v1's step 6). */
const CLOSE_MAX_BLOCKS = 8;
const TRAVELERS = ['alice', 'bob', 'charlie'] as const;

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
    env: { KITTY_REGISTRY: 'v2' },
  });
  api = {
    alice: stack.client('alice'),
    bob: stack.client('bob'),
    charlie: stack.client('charlie'),
    dave: stack.client('dave'),
  };
  for (const as of TRAVELERS) {
    before[as] = await waitFor(`${as} in the registry v2, with a balance`, async () => {
      const s = await state(as);
      return s.me?.balance && s.trip !== null && s.members.length === 3 ? s : undefined;
    });
  }
  note('before', Object.fromEntries(TRAVELERS.map((a) => [a, before[a]?.me?.balance])));
}, 120_000);

afterAll(async () => {
  await stack?.stop();
});

describe('the demo with KITTY_REGISTRY=v2 on the regtest stack (irreversible)', () => {
  it('step 1: three members in the registry v2, 50.00 each; dave is only the LSP', async () => {
    for (const as of TRAVELERS) {
      expect(before[as]).toMatchObject({ registry: 'v2', coordinator: null });
      expect(before[as]?.me?.balance?.tripOutboundCents).toBe(5000n);
      expect(before[as]?.members.map((m) => [m.memberId, m.status])).toEqual([
        ['alice', 'active'],
        ['bob', 'active'],
        ['charlie', 'active'],
      ]);
    }
    expect(await state('dave')).toMatchObject({ role: 'coordinator', trip: null, me: null });
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

  it('step 2: the sentence gives the split; the shares are 3.09 / 3.09 / 3.50', async () => {
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

  it('step 2: alice submits to the registry v2; the lines are 3.09 for bob and 3.50 for charlie', async () => {
    const t0 = Date.now();
    const expense = await api.alice.submitExpense({
      receipt,
      assignments,
      receiptImageSha256: createHash('sha256').update(photo).digest('hex'),
    });
    expenseId = expense.expenseId;
    const shares = Object.fromEntries(expense.lines.map((l) => [l.debtor, l.cents]));
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
    // bob, neither creditor nor debtor, is the one voter of this contest (23/10)
    const seen = await waitFor('bob sees the contest', async () =>
      (await state('bob')).expenses
        .find((e) => e.expenseId === expenseId)
        ?.lines.find((l) => l.debtor === 'charlie' && l.state === 'contested'),
    );
    expect(seen.group).toMatchObject({ voters: ['bob'], canVote: true, outcome: null });
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
    );
    expect(line.paidBy).toBe('debtor');
    expect(line.agent?.reason).toMatch(/3\.09/u);
    const hash = line.proof?.rail === 'ln' ? line.proof.paymentHash : '';
    const proof = await waitFor("the proof of bob's payment", () =>
      api.bob.getProof({ paymentHash: hash }),
    );
    const blocks = (await tipHeight()) - heightAtSubmit;
    note('bob paid', { afterMs: Date.now() - t0, reason: line.agent?.reason, proof, blocks });
    expect(proof.verified).toBe(true);
    expect(blocks).toBe(0);
    await waitFor('bob at 46.91', async () => {
      const b = (await state('bob')).me?.balance;
      return b?.tripOutboundCents === 4691n ? b : undefined;
    });
  });

  it('step 5: no coordinator decides: the routes of dave are refused', async () => {
    const r = await api.dave
      .resolveDispute({ expenseId, member: 'charlie', outcome: 'upheld', note: 'x' })
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(r?.code).toBe('NOT_ALLOWED');
    expect(r?.message).toMatch(/no coordinator/);
    // the contested line is never paid automatically
    expect(debt(await state('charlie'))?.state).toBe('contested');
  });

  it('step 5: charlie sees the line again and approves: the contest is withdrawn (C3), he pays 3.50', async () => {
    const t0 = Date.now();
    const approved = await api.charlie.decideLine({ id: expenseId, decision: 'approve' });
    expect(approved.state).toBe('due');
    const line = await waitFor(
      "charlie's line paid",
      async () => {
        const l = debt(await state('charlie'));
        return l?.state === 'paid' ? l : undefined;
      },
      60_000,
    );
    expect(line.agent?.reason).toMatch(/3\.50/u);
    const hash = line.proof?.rail === 'ln' ? line.proof.paymentHash : '';
    const proof = await waitFor("the proof of charlie's payment", () =>
      api.charlie.getProof({ paymentHash: hash }),
    );
    note('charlie paid', { afterMs: Date.now() - t0, reason: line.agent?.reason, proof });
    expect(proof.verified).toBe(true);
    await waitFor('charlie at 46.50', async () => {
      const b = (await state('charlie')).me?.balance;
      return b?.tripOutboundCents === 4650n ? b : undefined;
    });
  });

  it('step 6: alice is reimbursed 6.59, 3.09 from bob and 3.50 from charlie', async () => {
    const s = await waitFor('alice reimbursed', async () => {
      const x = await state('alice');
      return x.me?.balance?.tripOutboundCents === 5659n ? x : undefined;
    });
    const credits = s.me?.credits.filter((l) => l.expenseId === expenseId) ?? [];
    const by = Object.fromEntries(credits.map((l) => [l.debtor, [l.state, l.paidBy, l.cents]]));
    note('alice', { balance: s.me?.balance, credits: by });
    expect(by).toEqual({ bob: ['paid', 'debtor', 309n], charlie: ['paid', 'debtor', 350n] });
    expect(s.me?.owedToMeCents).toBe(0n);
  });

  it('B6: every traveler backed their node up to the relay, encrypted', async () => {
    const seed = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../infra/.out/seed-state.json', import.meta.url)),
        'utf8',
      ),
    ) as { pubkeys: Record<ActorId, string> };
    const sizes = await waitFor(
      "a backup of every traveler's node on the relay",
      async () => {
        const out: Record<string, number> = {};
        for (const a of TRAVELERS) {
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

  it('"Ledger verified" on every phone: the same registry state on 3/3', async () => {
    const heads = await waitFor('the same state on 3/3', async () => {
      const all = await Promise.all(TRAVELERS.map(state));
      const h = all.map((x) => x.ledger);
      return h.every((x) => x.headHash !== null && x.headHash === h[0]?.headHash) ? h : undefined;
    });
    note('ledger', heads);
    for (const h of heads) {
      expect(h.chainValid).toBe(true);
      expect(h.validSignatures).toBe(h.events);
    }
    // L = 30.00 covers the demo: the LSP opened no liquidity
    expect((await state('dave')).operations.filter((o) => o.kind === 'opening_liquidity')).toEqual(
      [],
    );
  });

  const leave = (who: MemberId) =>
    it(`step 7: ${who} leaves, closing their own channels with the LSP`, async () => {
      const was = (await state(who)).me?.balance;
      const h0 = await tipHeight();
      const t0 = Date.now();
      const r = await api[who].leaveTrip();
      const blocksMined = (await tipHeight()) - h0;
      note(`${who} left`, { ...r, ms: Date.now() - t0, blocksMined });
      expect(r.warning).toBeNull();
      expect(r.closingTxids).toHaveLength(2);
      expect(blocksMined).toBeLessThanOrEqual(CLOSE_MAX_BLOCKS);
      for (const txid of r.closingTxids) {
        const res = await fetch(`${ESPLORA}/tx/${txid}`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: { confirmed: boolean } }).status.confirmed).toBe(
          true,
        );
      }
      const b = await waitFor(
        `${who}'s DUSD back on-chain`,
        async () => {
          const x = (await state(who)).me?.balance;
          return x && was && x.onchainCents === was.onchainCents + was.tripOutboundCents
            ? x
            : undefined;
        },
        90_000,
        2_000,
      );
      note(`${who} balance`, b);
      expect(b.tripOutboundCents).toBe(0n);
      const me = (await state(who)).members.find((m) => m.memberId === who);
      expect(me?.status).toBe('left');
    });
  leave('bob');
  leave('charlie');
  leave('alice');

  it('step 7: everyone has left: the trip is closed on every phone', async () => {
    const all = await waitFor('the trip closed on 3/3', async () => {
      const x = await Promise.all(TRAVELERS.map(state));
      return x.every((s) => s.trip?.status === 'closed') ? x : undefined;
    });
    for (const s of all) expect(s.members.map((m) => m.status)).toEqual(['left', 'left', 'left']);
    note(
      'closed',
      all.map((s) => s.ledger.headHash),
    );
  });
});
