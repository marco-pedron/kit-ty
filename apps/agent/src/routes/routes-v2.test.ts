import {
  DEMO_TRIP_PARAMS,
  ExpenseViewSchema,
  LineViewSchema,
  ProofViewSchema,
  ReceiptSchema,
  SplitResponseSchema,
  TripViewSchema,
  sha256Hex,
  type ActorId,
} from '@kitty/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { DEMO_RECEIPT, DEMO_SENTENCE, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import type { AgentRuntime } from '../flows/runtime.js';
import { registryDemo, type RegistryDemo } from '../flows/test/setup.js';
import { buildAgentServer } from '../server.js';

// The routes with KITTY_REGISTRY=v2 (23/10): the three RegistryAgents of the fake network, the
// LSP, no coordinator. The story of the v2 demo through the API, as e2e:demo:v2 runs it.

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function serve(d: RegistryDemo) {
  const rt: AgentRuntime = {
    agents: new Map(),
    registry: 'v2',
    v2: {
      travelers: new Map(Object.entries(d.travelers) as never),
      lsp: d.lsp,
      transport: d.transport,
      params: DEMO_TRIP_PARAMS,
    },
    stop: () => undefined,
  };
  const config = loadConfig({ KITTY_FAKES: '1', ESPLORA_URL: 'http://127.0.0.1:3010' });
  app = buildAgentServer(config, {
    runtime: () => rt,
    now: d.now,
    onchainFound: async () => false,
  });
  return app;
}

async function call(
  a: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
) {
  const res = await a.inject({ method, url, ...(payload && { payload }) });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}
const state = async (a: FastifyInstance, as: ActorId) => {
  const r = await call(a, 'GET', `/api/${as}/state`);
  expect(r.status).toBe(200);
  return TripViewSchema.parse(r.json);
};
const encodeReceipt = () => z.encode(ReceiptSchema, DEMO_RECEIPT);

async function dinner(d: RegistryDemo, a: FastifyInstance) {
  const split = await call(a, 'POST', '/api/alice/expenses/split', {
    receipt: encodeReceipt(),
    text: DEMO_SENTENCE,
  });
  expect(split.status).toBe(200);
  expect(SplitResponseSchema.parse(split.json).preview?.shares).toEqual([
    { member: 'alice', cents: 309n },
    { member: 'bob', cents: 309n },
    { member: 'charlie', cents: 350n },
  ]);
  const sent = await call(a, 'POST', '/api/alice/expenses', {
    receipt: encodeReceipt(),
    assignments: DEMO_SPLIT.assignments,
    receiptImageSha256: PHOTO,
  });
  expect(sent.status).toBe(200);
  const expense = ExpenseViewSchema.parse(sent.json);
  await d.tickAll();
  return expense;
}

describe('agent routes with KITTY_REGISTRY=v2', () => {
  it('every traveler sees the trip of the registry; dave is only the LSP, with no trip', async () => {
    const d = await registryDemo();
    const a = serve(d);
    const alice = await state(a, 'alice');
    expect(alice).toMatchObject({ registry: 'v2', coordinator: null });
    expect(alice.trip).toMatchObject({ name: 'Vietnam 2026', status: 'open' });
    expect(alice.members.map((m) => [m.memberId, m.status])).toEqual([
      ['alice', 'active'],
      ['bob', 'active'],
      ['charlie', 'active'],
    ]);
    expect(alice.ledger).toMatchObject({ chainValid: true });
    expect(alice.activity.map((r) => r.kind)).toContain('TRIP_CREATED');
    const dave = await state(a, 'dave');
    expect(dave).toMatchObject({ role: 'coordinator', trip: null, me: null, coordinator: null });
  });

  it("dave's coordinator routes are not available", async () => {
    const d = await registryDemo();
    const a = serve(d);
    const id = (await dinner(d, a)).expenseId;
    for (const [method, url, body] of [
      ['POST', `/api/dave/disputes/${id}/charlie`, { outcome: 'upheld', note: 'x' }],
      ['POST', `/api/dave/defaults/${id}/charlie/cover-and-exclude`, undefined],
      ['PUT', '/api/dave/rates', { asOf: '2026-10-17', source: 'x', rates: { VND: '1' } }],
    ] as const) {
      const r = await call(a, method, url, body);
      expect(r.status).toBe(403);
      expect(r.json.error).toMatchObject({
        code: 'NOT_ALLOWED',
        message: expect.stringMatching(/no coordinator/),
      });
    }
  });

  it('the v2 demo: bob pays, charlie contests then approves and pays, everyone leaves', async () => {
    const d = await registryDemo();
    const a = serve(d);
    const expense = await dinner(d, a);
    const id = expense.expenseId;
    expect(expense.lines.map((l) => [l.debtor, l.cents])).toEqual([
      ['bob', 309n],
      ['charlie', 350n],
    ]);
    const contest = await call(a, 'POST', `/api/charlie/expenses/${id}/decision`, {
      decision: 'contest',
      reason: 'I only had water',
    });
    expect(LineViewSchema.parse(contest.json)).toMatchObject({ state: 'contested' });
    // bob may vote on charlie's contest; alice (the creditor) may not
    await d.tickAll();
    const bobView = await state(a, 'bob');
    const seenByBob = bobView.expenses[0]?.lines.find((l) => l.debtor === 'charlie');
    expect(seenByBob?.group).toMatchObject({ voters: ['bob'], canVote: true, outcome: null });
    const aliceView = await state(a, 'alice');
    expect(aliceView.me?.credits.find((l) => l.debtor === 'charlie')?.group?.canVote).toBe(false);

    d.advance(20);
    await d.tickAll();
    await d.tickAll();
    const bobLine = (await state(a, 'bob')).me?.debts[0];
    expect(bobLine).toMatchObject({ state: 'paid', paidBy: 'debtor' });
    expect(bobLine?.agent?.reason).toMatch(/3\.09/);
    const hash = bobLine?.proof?.rail === 'ln' ? bobLine.proof.paymentHash : '';
    const proof = ProofViewSchema.parse((await call(a, 'GET', `/api/proof/${hash}`)).json);
    expect(proof.verified).toBe(true);

    const approve = await call(a, 'POST', `/api/charlie/expenses/${id}/decision`, {
      decision: 'approve',
    });
    expect(LineViewSchema.parse(approve.json)).toMatchObject({ state: 'due' });
    await d.tickAll();
    await d.tickAll();
    expect((await state(a, 'charlie')).me?.debts[0]).toMatchObject({ state: 'paid' });
    expect((await state(a, 'alice')).me?.owedToMeCents).toBe(0n);

    for (const who of ['bob', 'charlie', 'alice'] as const) {
      const left = await call(a, 'POST', `/api/${who}/leave`);
      expect(left.status).toBe(200);
      expect(left.json).toMatchObject({
        closingTxids: [expect.any(String), expect.any(String)],
        warning: null,
      });
    }
    await d.tickAll();
    const end = await state(a, 'bob');
    expect(end.trip?.status).toBe('closed');
    expect(end.members.map((m) => m.status)).toEqual(['left', 'left', 'left']);
    expect(end.activity.filter((r) => r.kind === 'MEMBER_LEFT')).toHaveLength(3);
  });

  it('"same on 3/3" from the checkpoints; a new phone restores the registry from the seed', async () => {
    const d = await registryDemo();
    const a = serve(d);
    await dinner(d, a);
    d.advance(20);
    await d.tickAll();
    for (let i = 0; i < 3; i++) {
      d.advance(11);
      await d.tickAll();
    }
    for (const as of ['alice', 'bob', 'charlie'] as const)
      expect((await state(a, as)).ledger.checkpoints).toEqual({ matching: 3, compared: 3 });
    const before = (await state(a, 'bob')).ledger.headHash;
    const r = await call(a, 'POST', '/api/bob/restore-from-seed');
    expect(r.status).toBe(200);
    expect(r.json.events).toBeGreaterThan(10);
    expect((await state(a, 'bob')).ledger.headHash).toBe(before);
    // bob and charlie paid after the silent assent: nothing left to warn alice about
    expect((await state(a, 'alice')).me?.leaveWarning).toBeNull();
  });

  it('a vote through the route decides the line; leaving with a debt is refused', async () => {
    const d = await registryDemo();
    const a = serve(d);
    const id = (await dinner(d, a)).expenseId;
    await call(a, 'POST', `/api/charlie/expenses/${id}/decision`, {
      decision: 'contest',
      reason: 'I only had water',
    });
    const refused = await call(a, 'POST', '/api/charlie/leave');
    expect(refused.status).toBe(403);
    // before leaving, alice sees what is still owed to her and that it is collected outside
    expect((await state(a, 'alice')).me?.leaveWarning).toMatch(
      /still owed 3\.09 from bob .*3\.50 from charlie .*collected outside the app/,
    );
    await d.tickAll();
    const vote = await call(a, 'POST', `/api/bob/expenses/${id}/lines/charlie/vote`, {
      outcome: 'voided',
    });
    expect(vote.status).toBe(200);
    expect(LineViewSchema.parse(vote.json)).toMatchObject({
      state: 'voided',
      group: { outcome: 'voided' },
    });
  });
});
