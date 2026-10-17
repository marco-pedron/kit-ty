import { DEMO_TRIP_PARAMS, fakeVerifier, sha256Hex, type MemberId } from '@kitty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { CoordinatorAgent } from './dave.js';
import type { MemberAgent } from './member-agent.js';
import { demo, type Demo } from './test/setup.js';

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');

async function line(d: Demo, viewer: MemberAgent, debtor: MemberId, expenseId?: string) {
  await viewer.sync(); // read what the others published so far
  const key = await d.agents[debtor].authorPubkey();
  const l = [...(viewer.trip()?.lines.values() ?? [])].find(
    (x) => x.debtorPubkey === key && (expenseId === undefined || x.expenseId === expenseId),
  );
  if (!l) throw new Error(`no line of ${debtor}`);
  return l;
}

const balance = (d: Demo, who: string) => d.net.wallet(who).balances();

/** The dinner submitted at t = 0 and seen by bob and charlie at t = 0. */
async function dinner(d: Demo): Promise<string> {
  await d.tickAll();
  const e = await d.agents.alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
  await d.tickAll();
  const body = e.signed.inner.body as { expenseId: string };
  return body.expenseId;
}

describe('the demo, steps 2-7 of SPEC §16 (A5b)', () => {
  it('alice is reimbursed 6.59: 3.09 from bob, 3.50 guaranteed by the operator', async () => {
    const d = await demo();
    const { alice, bob, charlie, dave } = d.agents;

    // Step 1: the trip as set up by the flows (trip, rate, three members with channels).
    await d.tickAll();
    expect(dave.trip()?.members.size).toBe(3);
    expect([...(dave.trip()?.members.values() ?? [])].every((m) => m.channelsReady)).toBe(true);

    // Step 2: alice submits the dinner; one invoice per debtor from her node.
    const expenseId = await dinner(d);
    expect((await line(d, alice, 'bob')).cents).toBe(309n);
    expect((await line(d, alice, 'charlie')).cents).toBe(350n);

    // Step 4: charlie contests ("I only had water").
    d.advance(5);
    await charlie.decide(expenseId, 'contest', 'I only had water');
    expect(dave.trip()?.lines.size).toBe(2);
    expect((await line(d, dave, 'charlie')).state).toBe('contested');

    // Step 5: dave looks at the photo with alice and upholds the line: due again, 30 s.
    d.advance(5);
    await dave.resolveDispute(expenseId, 'charlie', 'upheld', 'Photo checked with alice');
    const upheld = await line(d, dave, 'charlie');
    expect(upheld.state).toBe('due');
    expect(upheld.deadlineAt?.getTime()).toBe(d.now().getTime() + 30_000);

    // Step 3: bob does nothing; at 20 s his agent pays 3.09, no block mined.
    d.advance(10);
    await d.tickAll();
    await d.tickAll();
    expect((await line(d, alice, 'bob')).state).toBe('paid');
    expect(bob.activity()[0]?.text).toBe(
      'Your agent paid 3.09 to alice: no objection in 20 s, under your limit of 20.00.',
    );
    // charlie's agent does not pay an upheld dispute on its own (payUpheldDisputes = false).
    const charlieLine = await line(d, charlie, 'charlie');
    expect(charlie.decisionFor(charlieLine)?.reason).toBe(
      "Dave upheld alice's expense: approve 3.50 yourself (your agent does not pay upheld disputes).",
    );

    // Step 6: charlie does not pay within 30 s → a default for dave.
    d.advance(19);
    await d.tickAll();
    expect(dave.trip()?.defaults).toHaveLength(0);
    d.advance(1);
    await d.tickAll();
    expect(dave.trip()?.defaults.map((l) => l.expenseId)).toEqual([expenseId]);

    // "Copri ed escludi": dave's node pays the same invoice, then closes charlie's channels.
    const result = await dave.coverAndExclude(expenseId, 'charlie');
    expect(result.closingTxids).toHaveLength(2);
    await d.tickAll();
    await d.tickAll();

    const covered = await line(d, alice, 'charlie');
    expect(covered.state).toBe('guaranteed');
    const payment = covered.payment;
    if (payment?.by !== 'guarantee') throw new Error('not guaranteed');
    expect(result.covered).toEqual({ rail: 'ln', paymentHash: payment.paymentHash });
    // Same invoice, same proof as if charlie had paid (SPEC §6.7).
    expect(sha256Hex(Buffer.from(payment.preimage, 'hex'))).toBe(payment.paymentHash);
    expect(alice.log.invoices.get(covered.bolt11)?.paymentHash).toBe(payment.paymentHash);

    const trip = dave.trip();
    const charlieKey = await charlie.authorPubkey();
    expect(trip?.members.get(charlieKey)).toMatchObject({
      excluded: true,
      closingTxids: result.closingTxids,
      guaranteeUsedCents: 350n,
    });
    expect(trip?.defaults).toEqual([]);

    // Step 7: alice reimbursed 6.59, nothing owed to her any more.
    expect(alice.me()?.owedToMeCents).toBe(0n);
    expect((await balance(d, 'alice')).tripOutboundCents).toBe(5000n + 309n + 350n);
    expect((await balance(d, 'bob')).tripOutboundCents).toBe(5000n - 309n);
    // charlie leaves with his own money: 50.00 back on-chain plus his 50.00 of the seed.
    expect(await balance(d, 'charlie')).toMatchObject({
      tripOutboundCents: 0n,
      onchainCents: 10_000n,
    });
    // dave covered 3.50 from the operator's liquidity.
    expect((await balance(d, 'dave')).tripOutboundCents).toBe(5000n - 350n);

    // "Registro verificato ✓, uguale su 4/4".
    const health = Object.values(d.agents).map((a) => a.log.health());
    expect(health.every((h) => h.chainValid && h.validSignatures === h.events)).toBe(true);
    expect(new Set(health.map((h) => h.headHash)).size).toBe(1);

    // charlie can no longer be included in a new expense.
    expect(() => alice.previewSplit(DEMO_RECEIPT, DEMO_SPLIT.assignments)).toThrow(
      /charlie is not an active traveler/,
    );
    const types = d.relay.events.map((e) => e.signed.inner.type);
    expect(types.filter((t) => t === 'PAYMENT_MADE')).toHaveLength(1);
    expect(types.filter((t) => t === 'GUARANTEE_PAID')).toHaveLength(1);
    expect(types.filter((t) => t === 'MEMBER_EXCLUDED')).toHaveLength(1);
  });
});

describe('CoordinatorAgent (A5b)', () => {
  it('only the coordinator of the trip can act as dave', async () => {
    const d = await demo();
    const impostor = new CoordinatorAgent({
      wallet: d.net.wallet('bob'),
      relay: d.relay,
      verifier: fakeVerifier,
      now: d.now,
    });
    await expect(
      impostor.setRate({ asOf: '2026-10-17', source: 'me', rates: { VND: '1' } }),
    ).rejects.toThrow(/only the coordinator/);
    await expect(
      d.agents.dave.createTrip({ name: 'x', assetId: 'y', params: DEMO_TRIP_PARAMS }),
    ).rejects.toThrow(/already exists/);
  });

  it('joining and admitting twice changes nothing', async () => {
    const d = await demo();
    const before = d.relay.events.length;
    await d.agents.bob.joinTrip();
    await d.agents.dave.admit('bob');
    expect(d.relay.events.length).toBe(before);
    await expect(d.agents.dave.joinTrip()).rejects.toThrow(/only travelers/);
  });

  it('resolves only contested lines; line_voided frees the debtor', async () => {
    const d = await demo();
    const id = await dinner(d);
    await expect(d.agents.dave.resolveDispute(id, 'bob', 'upheld', '')).rejects.toThrow(
      /not contested/,
    );
    await d.agents.bob.decide(id, 'contest', 'no pho for me');
    await d.agents.dave.resolveDispute(id, 'bob', 'line_voided', 'agreed');
    expect((await line(d, d.agents.alice, 'bob')).state).toBe('voided');
    await d.agents.bob.sync();
    expect(d.agents.bob.me()?.oweCents).toBe(0n);
  });

  it('covers only an overdue line', async () => {
    const d = await demo();
    const id = await dinner(d);
    await expect(d.agents.dave.coverAndExclude(id, 'charlie')).rejects.toThrow(/not overdue/);
  });

  it('beyond the guarantee left: excluded, not covered, alice keeps an off-chain credit', async () => {
    const d = await demo({ params: { guaranteeCapCents: 300n } });
    const id = await dinner(d);
    await d.agents.charlie.decide(id, 'contest', 'water only');
    await d.agents.dave.resolveDispute(id, 'charlie', 'upheld', 'ok');
    d.advance(30);
    await d.tickAll();
    const result = await d.agents.dave.coverAndExclude(id, 'charlie');
    expect(result.covered).toBeNull();
    await d.tickAll();
    expect((await line(d, d.agents.alice, 'charlie')).state).toBe('overdue');
    await d.agents.alice.sync();
    expect(d.agents.alice.me()?.owedToMeCents).toBe(350n + 309n); // bob's line too: no agent ticked between 20 s and 30 s
    expect(d.agents.dave.activity()[0]?.text).toMatch(/above the guarantee left for charlie/);
    expect((await balance(d, 'charlie')).tripOutboundCents).toBe(0n);
  });

  it("exclusion makes the member's other open lines overdue, and dave covers them too", async () => {
    const d = await demo();
    const first = await dinner(d);
    // A second expense charlie owes, still waiting for silent assent.
    const lunch = await d.agents.bob.submitExpense(
      DEMO_RECEIPT,
      [
        { itemIndex: 0, members: ['bob'] },
        { itemIndex: 1, members: ['charlie'] },
        { itemIndex: 2, members: ['bob', 'charlie'] },
      ],
      sha256Hex('lunch photo'),
    );
    const lunchId = (lunch.signed.inner.body as { expenseId: string }).expenseId;
    await d.agents.charlie.decide(first, 'contest', 'water only');
    await d.agents.dave.resolveDispute(first, 'charlie', 'upheld', 'ok');
    d.advance(30);
    await d.tickAll();
    await d.agents.dave.coverAndExclude(first, 'charlie');
    await d.tickAll();
    const trip = d.agents.dave.trip();
    expect((await line(d, d.agents.dave, 'charlie', first)).state).toBe('guaranteed');
    expect((await line(d, d.agents.dave, 'charlie', lunchId)).state).toBe('guaranteed');
    const used = trip?.members.get(await d.agents.charlie.authorPubkey())?.guaranteeUsedCents;
    expect(used).toBe(350n + (await line(d, d.agents.dave, 'charlie', lunchId)).cents);
  });
});
