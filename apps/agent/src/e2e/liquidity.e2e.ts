import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActorId, AgentClient, Receipt, TripView } from '@kitty/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, tipHeight, waitFor, type Stack } from './harness.js';

// B9 on the regtest stack (PLAN §4): a reimbursement larger than dave's liquidity to the
// creditor makes dave open a new liquidity channel before the payment. The demo numbers are
// unchanged (L = 30.00): bob owes alice 35.00 for a boat tour, more than alice can receive.
// IRREVERSIBLE: run `pnpm demo:reset` before and after (it is not the demo of SPEC §16).

const LOG =
  process.env.KITTY_E2E_LOG ??
  fileURLToPath(
    new URL('../../../../infra/.out/logs/e2e-liquidity-processes.log', import.meta.url),
  );

// 1,844,500 VND at 26,350 VND/USD = 70.00 USD, split between alice and bob: 35.00 each.
const BOAT_TOUR: Receipt = {
  merchant: 'Ha Long boat tour',
  date: '2026-10-17',
  currency: 'VND',
  items: [{ label: 'Boat tour', quantity: 2, unitPrice: 922_250n, total: 1_844_500n }],
  total: 1_844_500n,
  warnings: [],
};

let stack: Stack;
let api: Record<ActorId, AgentClient>;
let expenseId: string;
const state = (as: ActorId): Promise<TripView> => api[as].getState();
const log = (k: string, v: unknown) =>
  console.log(`[e2e] ${k}: ${JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}` : x))}`);

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
}, 150_000);

afterAll(async () => {
  await stack?.stop();
});

describe('B9 just-in-time liquidity on the regtest stack (irreversible)', () => {
  let aliceBefore: bigint;

  it('alice starts with 30.00 she can receive, a margin of 30.00', async () => {
    const s = await waitFor('alice balance', async () => {
      const x = await state('alice');
      return x.me?.balance ? x : undefined;
    });
    aliceBefore = s.me?.balance?.tripOutboundCents ?? 0n;
    expect(s.me?.balance?.inboundCents).toBe(3000n);
    const dave = await state('dave');
    const margin = dave.coordinator?.members.find((m) => m.memberId === 'alice');
    expect(margin?.liquidityMarginCents).toBe(3000n);
  });

  let openedAt = '';

  it('alice submits 35.00 owed by bob', async () => {
    const e = await api.alice.submitExpense({
      receipt: BOAT_TOUR,
      assignments: [{ itemIndex: 0, members: ['alice', 'bob'] }],
      receiptImageSha256: createHash('sha256').update('kitty e2e boat tour').digest('hex'),
    });
    expenseId = e.expenseId;
  });

  it('dave opens liquidity to alice right away: the largest line, 35.00', async () => {
    const t0 = Date.now();
    const h0 = await tipHeight();
    const op = await waitFor(
      "dave's liquidity opening",
      async () => {
        const o = (await state('dave')).operations.find((x) => x.kind === 'opening_liquidity');
        if (o?.status === 'failed') throw new Error(`opening failed: ${o.error?.message}`);
        return o?.status === 'done' ? o : undefined;
      },
      120_000,
      1_000,
    );
    openedAt = op.finishedAt ?? '';
    log('opened', { op, ms: Date.now() - t0, blocks: (await tipHeight()) - h0 });
    // margin 30.00 − 35.00 = −5.00 → threshold − margin = 15.00, but one payment goes through
    // one channel: dave opens the largest line, 35.00
    expect(op.text).toContain('Opening 35.00 of liquidity to alice');
    const dave = await state('dave');
    expect(dave.activity.some((a) => a.text.includes('Opened 35.00 of liquidity to alice'))).toBe(
      true,
    );
  });

  it("bob approves (above his automatic limit); his agent pays through dave's new channel", async () => {
    // still within the payment deadline of the demo (30 s from LINE_SEEN)
    const before = (await state('bob')).me?.debts.find((x) => x.expenseId === expenseId);
    log('bob line before approval', { state: before?.state, deadlineAt: before?.deadlineAt });
    expect(['awaiting_decision', 'awaiting_explicit']).toContain(before?.state);
    await api.bob.decideLine({ id: expenseId, decision: 'approve' });
    const paid = await waitFor(
      "bob's line paid",
      async () => {
        const l = (await state('bob')).me?.debts.find((x) => x.expenseId === expenseId);
        return l?.state === 'paid' ? l : undefined;
      },
      90_000,
    );
    const bob = await state('bob');
    const payment = bob.activity.find((a) => a.kind === 'AGENT' && a.proof !== null);
    log('paid', { agent: paid.agent, proof: paid.proof, at: payment?.at, openedAt });
    expect(paid.cents).toBe(3500n);
    expect(Date.parse(payment?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(openedAt));
    const alice = await waitFor('alice +35.00', async () => {
      const b = (await state('alice')).me?.balance;
      return b?.tripOutboundCents === aliceBefore + 3500n ? b : undefined;
    });
    log('alice balance', alice);
    const margin = (await state('dave')).coordinator?.members.find((m) => m.memberId === 'alice');
    expect(margin?.liquidityMarginCents).toBe(3000n); // 30.00 + 35.00 opened − 35.00 received
  });
});
