import { sha256Hex, signingMessage, type EventInner } from '@kitty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { FlowError } from './errors.js';
import type { MemberAgent } from './member-agent.js';
import { demo, type Demo } from './test/setup.js';

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');

async function lineOf(d: Demo, agent: MemberAgent, debtor: 'bob' | 'charlie') {
  const trip = agent.trip();
  const key = await d.agents[debtor].authorPubkey();
  const line = [...(trip?.lines.values() ?? [])].find((l) => l.debtorPubkey === key);
  if (!trip || !line) throw new Error('no line');
  return { trip, line };
}

describe('MemberAgent (A5a)', () => {
  it('every agent verifies the seeded trip on its own', async () => {
    const d = await demo();
    await d.tickAll();
    await d.tickAll(); // the checkpoints of the agents that ticked later
    for (const a of Object.values(d.agents)) {
      // 11 seeded events, plus the CHECKPOINTs the agents published meanwhile.
      const h = a.log.health();
      expect(h).toMatchObject({ chainValid: true, headSeq: d.relay.events.length });
      expect(h.validSignatures).toBe(h.events);
      expect(a.trip()?.members.size).toBe(3);
    }
    expect(d.agents.alice.me()?.memberId).toBe('alice');
    expect(d.agents.dave.me()).toBeNull();
  });

  it('previews the shares with the rate of the day; the ledger, not the AI, computes them', async () => {
    const d = await demo();
    await d.tickAll();
    expect(d.agents.alice.previewSplit(DEMO_RECEIPT, DEMO_SPLIT.assignments)).toEqual({
      rate: '26350',
      rateAsOf: '2026-10-17',
      totalUsdCents: 968n,
      shares: [
        { member: 'alice', cents: 309n },
        { member: 'bob', cents: 309n },
        { member: 'charlie', cents: 350n },
      ],
    });
    const bad = (assignments: typeof DEMO_SPLIT.assignments) => () =>
      d.agents.alice.previewSplit(DEMO_RECEIPT, assignments);
    expect(bad(DEMO_SPLIT.assignments.slice(0, 2))).toThrow(/item 2 is not assigned/);
    expect(bad([...DEMO_SPLIT.assignments, { itemIndex: 7, members: ['bob'] }])).toThrow(
      /not on the receipt/,
    );
    expect(
      bad([{ itemIndex: 0, members: ['alice'] }, ...DEMO_SPLIT.assignments.slice(1)]),
    ).not.toThrow();
    expect(() => d.agents.dave.previewSplit(DEMO_RECEIPT, DEMO_SPLIT.assignments)).toThrow(
      FlowError,
    );
  });

  it('alice submits the dinner → bob pays automatically after 20 s of silence', async () => {
    const d = await demo();
    await d.tickAll();
    const { alice, bob, charlie, dave } = d.agents;

    // SPEC §6.3: one invoice per debtor from alice's node, signed expense on the relay.
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll(); // bob and charlie see it: LINE_SEEN, silent assent starts now
    const seen = await lineOf(d, bob, 'bob');
    expect(seen.line).toMatchObject({ state: 'awaiting_decision', cents: 309n });
    expect(bob.decisionFor(seen.line)?.reason).toBe(
      'Will pay 3.09 to alice in 20 s unless you object.',
    );

    // charlie objects (SPEC §16 step 4); bob does nothing.
    d.advance(5);
    await charlie.decide(seen.line.expenseId, 'contest', 'I only had water');

    d.advance(14); // 19 s after LINE_SEEN: still waiting
    await d.tickAll();
    expect((await lineOf(d, bob, 'bob')).line.state).toBe('awaiting_decision');

    d.advance(1); // exactly 20 s: silent assent, bob's agent pays
    await d.tickAll();
    await d.tickAll(); // everyone syncs the PAYMENT_MADE
    const { trip, line } = await lineOf(d, alice, 'bob');
    expect(line.state).toBe('paid');
    expect(line.payment?.by).toBe('debtor');
    const payment = line.payment;
    if (payment === null || payment.by !== 'debtor' || payment.rail !== 'ln') throw new Error('ln');
    // The proof anyone can check (SPEC §10.2): sha256(preimage) = payment hash of alice's invoice.
    expect(sha256Hex(Buffer.from(payment.preimage, 'hex'))).toBe(payment.paymentHash);
    expect(alice.log.invoices.get(line.bolt11)?.paymentHash).toBe(payment.paymentHash);
    expect(trip.members.get(line.payerPubkey)?.owedToMeCents).toBe(350n);

    // The agent says why; Attività carries the proof.
    expect(bob.decisionFor(line)?.reason).toBe(
      'Paid 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00.',
    );
    expect(bob.activity()[0]).toMatchObject({
      kind: 'AGENT',
      text: 'Your agent paid 3.09 to alice: no objection in 20 s, under your limit of 20.00.',
      proof: { rail: 'ln', paymentHash: payment.paymentHash },
    });
    expect(bob.operations()[0]).toMatchObject({ kind: 'paying', status: 'done' });

    // Money moved on the fake channels; charlie's contested line was never paid.
    expect((await d.net.wallet('alice').balances()).tripOutboundCents).toBe(5309n);
    expect((await d.net.wallet('bob').balances()).tripOutboundCents).toBe(4691n);
    expect((await lineOf(d, charlie, 'charlie')).line.state).toBe('contested');
    expect((await d.net.wallet('charlie').balances()).tripOutboundCents).toBe(5000n);

    // Same verified log everywhere, no extra payment on later ticks.
    d.advance(30);
    await d.tickAll();
    const heads = Object.values(d.agents).map((a) => a.log.health().headHash);
    expect(new Set(heads).size).toBe(1);
    expect(d.relay.events.filter((e) => e.signed.inner.type === 'PAYMENT_MADE')).toHaveLength(1);
    expect(dave.log.health().chainValid).toBe(true);
  });

  it('above the automatic limit nothing is paid until bob approves', async () => {
    const d = await demo();
    await d.tickAll();
    const { alice, bob } = d.agents;
    await bob.updatePolicy({
      autoPayLimitCents: 300n,
      dailyCapCents: 6000n,
      payUpheldDisputes: false,
    });
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll();
    d.advance(25);
    await d.tickAll();
    const waiting = (await lineOf(d, bob, 'bob')).line;
    expect(waiting.state).toBe('awaiting_explicit');
    expect(bob.decisionFor(waiting)?.reason).toBe(
      'Not paid: 3.09 is above your automatic limit of 3.00. Approve it yourself.',
    );
    const expenseId = waiting.expenseId;
    await bob.decide(expenseId, 'approve');
    await d.tickAll();
    await d.tickAll();
    expect((await lineOf(d, alice, 'bob')).line.state).toBe('paid');
    expect(bob.activity()[0]?.text).toBe('Your agent paid 3.09 to alice: you approved it.');
  });

  it('a failed payment is retried after the back-off and never paid twice', async () => {
    const d = await demo({ retryMs: 5_000 });
    await d.tickAll();
    const { alice, bob } = d.agents;
    d.net.account('bob').tripOutboundCents = 100n; // not enough for 3.09
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll();
    d.advance(20);
    await d.tickAll();
    expect(bob.operations()[0]).toMatchObject({ kind: 'paying', status: 'failed' });
    expect(bob.operations()[0]?.error?.code).toBe('TOPUP_REQUIRED');
    expect(bob.activity()[0]?.text).toMatch(/^Payment of 3.09 to alice failed/);

    d.net.account('bob').tripOutboundCents = 5000n; // topped up
    d.advance(3);
    await d.tickAll();
    expect((await lineOf(d, bob, 'bob')).line.state).toBe('due'); // still in the back-off
    d.advance(2);
    await d.tickAll();
    await d.tickAll();
    expect((await lineOf(d, alice, 'bob')).line.state).toBe('paid');
    const bobKey = await bob.authorPubkey();
    const bobPayments = d.relay.events.filter(
      (e) => e.signed.inner.type === 'PAYMENT_MADE' && e.signed.inner.author === bobKey,
    );
    expect(bobPayments).toHaveLength(1);
    expect((await d.net.wallet('bob').balances()).tripOutboundCents).toBe(5000n - 309n);
  });

  it('the creditor reissues an expired invoice, and the debtor pays the new one', async () => {
    const d = await demo();
    await d.tickAll();
    const { alice, bob } = d.agents;
    await bob.updatePolicy({
      autoPayLimitCents: 0n,
      dailyCapCents: 6000n,
      payUpheldDisputes: false,
    });
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll();
    const first = (await lineOf(d, bob, 'bob')).line.bolt11;
    // The fake node expires invoices on the wall clock: age them by hand.
    const inv = d.net.invoices.get(first);
    if (!inv) throw new Error('no invoice');
    inv.expiresAt = new Date(Date.now() - 1000).toISOString();
    // Every agent decoded it with its own node: all of them now read the expired date.
    for (const a of Object.values(d.agents)) {
      const cached = a.log.invoices.get(first);
      if (cached) a.log.invoices.set(first, { ...cached, expiresAt: inv.expiresAt });
    }
    d.advance(1);
    await d.tickAll();
    await d.tickAll();
    const reissued = (await lineOf(d, bob, 'bob')).line;
    expect(reissued.bolt11).not.toBe(first);
    await bob.decide(reissued.expenseId, 'approve');
    await d.tickAll();
    await d.tickAll();
    expect((await lineOf(d, alice, 'bob')).line.state).toBe('paid');
  });

  it('overlapping ticks do not publish twice', async () => {
    const d = await demo();
    await Promise.all([d.agents.bob.tick(), d.agents.bob.tick(), d.agents.bob.tick()]);
    const bobKey = await d.agents.bob.authorPubkey();
    const mine = d.relay.events.filter(
      (e) => e.signed.inner.type === 'CHECKPOINT' && e.signed.inner.author === bobKey,
    );
    expect(mine).toHaveLength(1);
  });

  it('publishes a CHECKPOINT every 10 new events', async () => {
    const d = await demo();
    await d.tickAll(); // 11 seeded events: one checkpoint per agent
    const checkpoints = d.relay.events.filter((e) => e.signed.inner.type === 'CHECKPOINT');
    expect(checkpoints).toHaveLength(4);
    await d.tickAll();
    expect(d.relay.events.filter((e) => e.signed.inner.type === 'CHECKPOINT')).toHaveLength(4);
  });

  it('never trusts the relay: a forged event freezes the copy and is reported', async () => {
    const d = await demo({ strict: false });
    await d.tickAll();
    const { alice, bob } = d.agents;
    // The relay forges a payment "by bob" with a signature that is not his.
    const real = d.relay.events[0];
    if (!real) throw new Error('no event');
    const inner = {
      ...real.signed.inner,
      type: 'POLICY_UPDATED',
      author: await bob.authorPubkey(),
      nonce: 'f'.repeat(32),
      body: {
        policy: { autoPayLimitCents: 999_999n, dailyCapCents: 999_999n, payUpheldDisputes: true },
      },
    } as EventInner;
    d.relay.inject({ inner, sig: sha256Hex(`forged:${signingMessage(inner)}`) });
    await d.tickAll();
    for (const a of [alice, bob]) {
      expect(a.log.health().chainValid).toBe(false);
      expect(a.log.divergence?.reason).toBe('invalid signature');
      expect(a.policy(a.trip()).autoPayLimitCents).toBe(2000n);
    }
  });
});
