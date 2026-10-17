import {
  CoverAndExcludeResponseSchema,
  ExpenseViewSchema,
  LineViewSchema,
  ProofViewSchema,
  ReceiptResultSchema,
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
import { demo, type Demo } from '../flows/test/setup.js';
import { buildAgentServer, type AgentServerDeps } from '../server.js';
import type { MemberAgent } from '../flows/member-agent.js';
import { MemoryRelay } from '../flows/test/memory-relay.js';
import type { Wallet } from '../wallet/types.js';
import { seedFakeTrip, startAgents, type AgentRuntime } from '../flows/runtime.js';
import { FakeLightningNetwork } from '../dev-fakes/fake-wallet.js';

// The routes over the real MemberAgents of A5a: four agents on one fake Lightning network and an
// in-memory relay with the real validateEvent, the demo trip already set up (flows/test/setup).

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');
const ACTORS = ['alice', 'bob', 'charlie', 'dave'] as const;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The agents of A's demo() as the runtime the server reads (startAgents, minus the timer). */
const runtimeOf = (d: Demo): AgentRuntime => ({
  agents: new Map<ActorId, MemberAgent>(ACTORS.map((a) => [a, d.agents[a]])),
  dave: d.agents.dave,
  stop: () => undefined,
});

function serve(d: Demo | null, deps: AgentServerDeps = {}) {
  const config = loadConfig({ KITTY_FAKES: '1', ESPLORA_URL: 'http://127.0.0.1:3010' });
  const rt = d && runtimeOf(d);
  app = buildAgentServer(config, {
    ...(d && { runtime: () => rt, now: d.now }),
    onchainFound: async () => false,
    ...deps,
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

/** The demo dinner sent through the routes: split preview, then submit. */
async function dinner(d: Demo, a: FastifyInstance) {
  await d.tickAll();
  const split = await call(a, 'POST', '/api/alice/expenses/split', {
    receipt: encodeReceipt(),
    text: DEMO_SENTENCE,
  });
  expect(split.status).toBe(200);
  const { result, preview } = SplitResponseSchema.parse(split.json);
  expect(result.ok).toBe(true);
  expect(preview?.shares).toEqual([
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
  await d.tickAll(); // bob and charlie see their lines
  return expense;
}
const encodeReceipt = () => z.encode(ReceiptSchema, DEMO_RECEIPT);

describe('agent routes over MemberAgent', () => {
  it('serves the seeded trip to every window, each with its own view', async () => {
    const d = await demo();
    const a = serve(d);
    await d.tickAll();
    const alice = await state(a, 'alice');
    expect(alice.trip).toMatchObject({ name: 'Vietnam 2026', status: 'open' });
    expect(alice.members.map((m) => [m.memberId, m.status])).toEqual([
      ['alice', 'active'],
      ['bob', 'active'],
      ['charlie', 'active'],
    ]);
    // from alice's own (fake) node
    expect(alice.me?.balance).not.toBeNull();
    expect(alice.ai).toEqual({ status: 'ready', fake: true });
    expect(alice.ledger).toMatchObject({ chainValid: true });
    expect(alice.ledger.validSignatures).toBe(alice.ledger.events);
    expect(alice.activity.map((r) => r.kind)).toContain('TRIP_CREATED');
    const dave = await state(a, 'dave');
    expect(dave).toMatchObject({ role: 'coordinator', me: null });
    expect(dave.coordinator?.members.map((m) => m.guaranteeLeftCents)).toEqual([
      5000n,
      5000n,
      5000n,
    ]);
  });

  it('runs the demo: submit, contest, silent assent and automatic payment, proof', async () => {
    const d = await demo();
    const a = serve(d);
    const expense = await dinner(d, a);
    expect(expense.lines.map((l) => [l.debtor, l.cents])).toEqual([
      ['bob', 309n],
      ['charlie', 350n],
    ]);
    expect(expense.items.find((i) => i.label.includes('Water'))?.members).toEqual([
      'alice',
      'bob',
      'charlie',
    ]);

    // bob: countdown of the silent assent and the agent's sentence.
    const bob = await state(a, 'bob');
    const debt = bob.me!.debts[0]!;
    expect(debt).toMatchObject({ state: 'awaiting_decision', payer: 'alice', cents: 309n });
    expect(Date.parse(debt.deadlineAt!) - Date.parse(debt.seenAt!)).toBe(20_000);
    expect(debt.agent?.reason).toEqual(expect.any(String));

    // charlie contests from the route.
    const contest = await call(a, 'POST', `/api/charlie/expenses/${expense.expenseId}/decision`, {
      decision: 'contest',
      reason: 'I only had water',
    });
    expect(contest.status).toBe(200);
    expect(LineViewSchema.parse(contest.json)).toMatchObject({
      state: 'contested',
      contestReason: 'I only had water',
    });
    await d.tickAll(); // dave's copy syncs at its next tick (every second in the server)
    const disputes = (await state(a, 'dave')).coordinator!.disputes;
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({
      debtor: 'charlie',
      reason: 'I only had water',
      receiptImageSha256: PHOTO,
    });
    expect(disputes[0]!.items.map((i) => i.label)).toEqual(
      DEMO_RECEIPT.items
        .filter((_, i) => expense.lines[1]!.itemIndexes.includes(i))
        .map((i) => i.label),
    );

    // 20 s later bob's agent pays on its own.
    d.advance(20);
    await d.tickAll();
    await d.tickAll();
    const paid = (await state(a, 'bob')).me!.debts[0]!;
    expect(paid).toMatchObject({ state: 'paid', paidBy: 'debtor' });
    expect(paid.proof?.rail).toBe('ln');
    const alice = await state(a, 'alice');
    expect(alice.me!.credits.map((l) => [l.debtor, l.state])).toEqual([
      ['bob', 'paid'],
      ['charlie', 'contested'],
    ]);
    expect(
      alice.activity.some(
        (r) => r.kind === 'PAYMENT_MADE' && r.text.includes('bob paid 3.09 to alice'),
      ),
    ).toBe(true);

    // The proof panel: three explicit checks, all green.
    const hash = paid.proof!.rail === 'ln' ? paid.proof!.paymentHash : '';
    const proof = await call(a, 'GET', `/api/proof/${hash}`);
    expect(proof.status).toBe(200);
    const p = ProofViewSchema.parse(proof.json);
    expect(p).toMatchObject({
      rail: 'ln',
      verified: true,
      creditor: 'alice',
      debtor: 'bob',
      paidBy: 'debtor',
    });
    if (p.rail === 'ln') {
      expect(Object.values(p.checks).every((c) => c.ok)).toBe(true);
    }
  });

  it('updates the policy and voids an expense', async () => {
    const d = await demo();
    const a = serve(d);
    const expense = await dinner(d, a);
    const policy = { autoPayLimitCents: '500', dailyCapCents: '1000', payUpheldDisputes: true };
    const put = await call(a, 'PUT', '/api/bob/policy', { policy });
    expect(put).toMatchObject({ status: 200, json: policy });
    expect((await state(a, 'bob')).me?.policy.autoPayLimitCents).toBe(500n);

    const voided = await call(a, 'POST', `/api/alice/expenses/${expense.expenseId}/void`);
    expect(voided.status).toBe(200);
    expect(ExpenseViewSchema.parse(voided.json)).toMatchObject({ status: 'voided' });
    const notPayer = await call(a, 'POST', `/api/bob/expenses/${expense.expenseId}/void`);
    expect(notPayer).toMatchObject({ status: 403, json: { error: { code: 'NOT_ALLOWED' } } });
  });

  it('extracts a receipt with the on-device AI', async () => {
    const a = serve(await demo());
    const r = await call(a, 'POST', '/api/alice/expenses/extract', {
      image: { mimeType: 'image/jpeg', dataBase64: Buffer.from('photo').toString('base64') },
    });
    expect(r.status).toBe(200);
    expect(ReceiptResultSchema.parse(r.json)).toMatchObject({ ok: true });
  });
});

describe("dave's routes over CoordinatorAgent", () => {
  it('upholds the contest, then covers and excludes charlie (SPEC §16 steps 5-6)', async () => {
    const d = await demo();
    const a = serve(d);
    const expense = await dinner(d, a);
    await call(a, 'POST', `/api/charlie/expenses/${expense.expenseId}/decision`, {
      decision: 'contest',
      reason: 'I only had water',
    });
    await d.tickAll();

    const upheld = await call(a, 'POST', `/api/dave/disputes/${expense.expenseId}/charlie`, {
      outcome: 'upheld',
      note: 'The photo shows two beers',
    });
    expect(upheld.status).toBe(200);
    expect(LineViewSchema.parse(upheld.json)).toMatchObject({
      debtor: 'charlie',
      state: 'due',
      resolution: { outcome: 'upheld', note: 'The photo shows two beers' },
    });

    // charlie does not pay (payUpheldDisputes is off): past the deadline the line is overdue.
    d.advance(20); // bob's silent assent: his agent pays
    await d.tickAll();
    await d.tickAll();
    d.advance(11);
    await d.tickAll();
    const defaults = (await state(a, 'dave')).coordinator!.defaults;
    expect(defaults).toMatchObject([
      { debtor: 'charlie', payer: 'alice', cents: 350n, coverable: true },
    ]);

    const cover = await call(
      a,
      'POST',
      `/api/dave/defaults/${expense.expenseId}/charlie/cover-and-exclude`,
    );
    expect(cover.status).toBe(200);
    const { covered, closingTxids } = CoverAndExcludeResponseSchema.parse(cover.json);
    expect(covered?.rail).toBe('ln');
    expect(closingTxids.length).toBeGreaterThan(0);
    await d.tickAll();

    const alice = await state(a, 'alice');
    expect(alice.me!.credits.find((l) => l.debtor === 'charlie')).toMatchObject({
      state: 'guaranteed',
      paidBy: 'guarantee',
    });
    expect(alice.members.find((m) => m.memberId === 'charlie')).toMatchObject({
      status: 'excluded',
      closingTxids,
    });
    const dave = await state(a, 'dave');
    expect(dave.coordinator!.members.find((m) => m.memberId === 'charlie')).toMatchObject({
      guaranteeUsedCents: 350n,
      guaranteeLeftCents: 4650n,
      operatorCreditCents: 350n,
    });
    const hash = covered!.rail === 'ln' ? covered!.paymentHash : '';
    const proof = ProofViewSchema.parse((await call(a, 'GET', `/api/proof/${hash}`)).json);
    expect(proof).toMatchObject({ verified: true, paidBy: 'guarantee', debtor: 'charlie' });
  });

  it('sets the rate of the day', async () => {
    const d = await demo();
    const a = serve(d);
    await d.tickAll();
    const rate = { asOf: '2026-10-18', source: 'infra/rates.json', rates: { VND: '26400' } };
    expect(await call(a, 'PUT', '/api/dave/rates', rate)).toMatchObject({
      status: 200,
      json: rate,
    });
    await d.tickAll();
    expect((await state(a, 'alice')).rate).toEqual(rate);
  });
});

describe('agent routes over the runtime of startAgents', () => {
  it('serves the trip that seedFakeTrip prepared, through the ticking agents', async () => {
    const net = new FakeLightningNetwork();
    const relay = new MemoryRelay(net, () => new Date());
    const wallets = {} as Record<ActorId, Wallet>;
    for (const x of ACTORS) wallets[x] = net.wallet(x);
    const log = { info: () => undefined, warn: () => undefined };
    const rt = startAgents({ fakes: true, relay, wallets, log, tickMs: 20 });
    try {
      await seedFakeTrip(rt, net.assetId, log);
      const a = serve(null, { runtime: () => rt });
      await vi.waitFor(
        async () => {
          const view = await state(a, 'bob');
          expect(view.trip?.name).toBe('Vietnam 2026');
          expect(view.members.filter((m) => m.status === 'active')).toHaveLength(3);
          expect(view.me?.memberId).toBe('bob');
        },
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      rt.stop();
      for (const ag of rt.agents.values()) await ag.idle();
    }
  });
});

describe('agent routes: roles, validation and errors', () => {
  it('refuses traveler actions to dave and unknown members', async () => {
    const a = serve(await demo());
    const r = await call(a, 'POST', '/api/dave/expenses', {
      receipt: encodeReceipt(),
      assignments: DEMO_SPLIT.assignments,
      receiptImageSha256: PHOTO,
    });
    expect(r).toMatchObject({
      status: 403,
      json: { error: { code: 'NOT_ALLOWED', action: expect.stringMatching(/traveler/) } },
    });
    expect(await call(a, 'GET', '/api/nobody/state')).toMatchObject({
      status: 404,
      json: { error: { code: 'NOT_FOUND' } },
    });
  });

  it("refuses dave's actions on lines in the wrong state, with the flow's reason", async () => {
    const d = await demo();
    const a = serve(d);
    const expense = await dinner(d, a);
    const r = await call(a, 'POST', `/api/dave/disputes/${expense.expenseId}/bob`, {
      outcome: 'upheld',
      note: 'ok',
    });
    expect(r).toMatchObject({ status: 403, json: { error: { code: 'NOT_ALLOWED' } } });
    expect((r.json.error as { message: string }).message).toMatch(/not contested/);
  });

  it('validates bodies and params with the shared schemas', async () => {
    const d = await demo();
    const a = serve(d);
    const expense = await dinner(d, a);
    const noReason = await call(a, 'POST', `/api/bob/expenses/${expense.expenseId}/decision`, {
      decision: 'contest',
    });
    expect(noReason).toMatchObject({ status: 400, json: { error: { code: 'VALIDATION_ERROR' } } });
    expect((noReason.json.error as { message: string }).message).toMatch(/reason/);
    expect(await call(a, 'GET', '/api/proof/not-hex')).toMatchObject({ status: 400 });
    expect(await call(a, 'GET', `/api/proof/${'a'.repeat(64)}`)).toMatchObject({ status: 404 });
    // A line that is not bob's: the flow's own refusal comes through with its code.
    const other = await call(a, 'POST', '/api/bob/expenses/nope/decision', { decision: 'approve' });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(other.json.error).toMatchObject({
      code: expect.any(String),
      action: expect.any(String),
    });
  });

  it('says what to do when the agent or the AI is not running', async () => {
    const a = serve(null, { ai: null });
    const send = await call(a, 'PUT', '/api/alice/policy', {
      policy: { autoPayLimitCents: '2000', dailyCapCents: '6000', payUpheldDisputes: false },
    });
    expect(send).toMatchObject({
      status: 503,
      json: {
        error: { code: 'AGENT_NOT_READY', action: expect.stringMatching(/Start the agents/) },
      },
    });
    const extract = await call(a, 'POST', '/api/alice/expenses/extract', {
      image: { mimeType: 'image/png', dataBase64: '' },
    });
    expect(extract).toMatchObject({ status: 503, json: { error: { code: 'AI_NOT_READY' } } });
    // /state still answers: an empty trip, so the UI can say what is missing.
    const view = await state(a, 'alice');
    expect(view).toMatchObject({ trip: null, me: { memberId: 'alice', balance: null } });
  });
});
