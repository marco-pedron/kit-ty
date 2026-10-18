import { sha256Hex, type MemberId, type SplitAssignment } from '@kitty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { demo, type Demo } from './test/setup.js';

// Payments after a dispute (demo bug: "after dave confirmed bob's dispute, neither bob nor
// charlie paid and alice got nothing"). Four agents, the flows, a manual clock; the trip
// windows of the tests: silent assent 20 s, payment deadline 30 s.

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');

async function lineOf(d: Demo, debtor: MemberId, expenseId: string) {
  await d.agents.alice.sync();
  const key = await d.agents[debtor].authorPubkey();
  const l = [...(d.agents.alice.trip()?.lines.values() ?? [])].find(
    (x) => x.debtorPubkey === key && x.expenseId === expenseId,
  );
  if (!l) throw new Error(`no line of ${debtor} on ${expenseId}`);
  return l;
}

async function submit(d: Demo, assignments: readonly SplitAssignment[] = DEMO_SPLIT.assignments) {
  const e = await d.agents.alice.submitExpense(DEMO_RECEIPT, assignments, PHOTO);
  await d.tickAll(); // bob and charlie see it
  return (e.signed.inner.body as { expenseId: string }).expenseId;
}

/** `seconds` of one-second ticks, as the server runs the agents. */
async function run(d: Demo, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    d.advance(1);
    await d.tickAll();
  }
}

const aliceTrip = async (d: Demo) => (await d.net.wallet('alice').balances()).tripOutboundCents;

describe('payments after a dispute', () => {
  it('bob contests, dave upholds, bob approves: alice receives both shares', async () => {
    const d = await demo();
    const { bob, dave } = d.agents;
    await d.tickAll();
    const before = await aliceTrip(d);
    const id = await submit(d);

    d.advance(3);
    await bob.decide(id, 'contest', 'I did not have the pho');
    d.advance(3);
    await dave.resolveDispute(id, 'bob', 'upheld', 'Photo checked with alice');
    expect((await lineOf(d, 'bob', id)).state).toBe('due');

    // charlie never contested: his agent pays on silent assent, the dispute does not block it
    await run(d, 20);
    expect((await lineOf(d, 'charlie', id)).state).toBe('paid');
    // bob's agent waits for his OK (payUpheldDisputes = false, SPEC §6.6)
    expect((await lineOf(d, 'bob', id)).state).toBe('due');

    await bob.decide(id, 'approve');
    await run(d, 2);
    expect((await lineOf(d, 'bob', id)).state).toBe('paid');
    expect(await aliceTrip(d)).toBe(before + 309n + 350n);
    expect(d.agents.alice.me()?.owedToMeCents).toBe(0n);
  });

  it('bob approves the upheld line only after its deadline: his agent still pays it', async () => {
    const d = await demo();
    const { bob, dave } = d.agents;
    await d.tickAll();
    const before = await aliceTrip(d);
    const id = await submit(d);

    d.advance(3);
    await bob.decide(id, 'contest', 'I did not have the pho');
    d.advance(3);
    await dave.resolveDispute(id, 'bob', 'upheld', 'Photo checked with alice');
    await run(d, 31); // past the new deadline: overdue, on dave's list of defaults
    expect((await lineOf(d, 'bob', id)).state).toBe('overdue');
    expect(dave.trip()?.defaults.map((l) => l.expenseId)).toEqual([id]);

    await bob.decide(id, 'approve');
    await run(d, 2);
    expect((await lineOf(d, 'bob', id)).state).toBe('paid');
    expect(bob.activity()[0]?.text).toBe('Your agent paid 3.09 to alice: you approved it.');
    expect(await aliceTrip(d)).toBe(before + 309n + 350n);
    expect(dave.trip()?.defaults).toEqual([]);
  });

  it("dave voids bob's part: charlie pays his share, bob owes nothing", async () => {
    const d = await demo();
    const { bob, dave } = d.agents;
    await d.tickAll();
    const before = await aliceTrip(d);
    const id = await submit(d);

    d.advance(3);
    await bob.decide(id, 'contest', 'I was not at dinner');
    d.advance(3);
    await dave.resolveDispute(id, 'bob', 'line_voided', 'Bob was not there');
    await run(d, 20);
    expect((await lineOf(d, 'bob', id)).state).toBe('voided');
    expect((await lineOf(d, 'charlie', id)).state).toBe('paid');
    expect(await aliceTrip(d)).toBe(before + 350n);
  });

  it('dave cancels the expense, alice sends it again corrected: the new shares are paid', async () => {
    const d = await demo();
    const { bob, dave } = d.agents;
    await d.tickAll();
    const before = await aliceTrip(d);
    const first = await submit(d);

    d.advance(3);
    await bob.decide(first, 'contest', 'I only had water');
    d.advance(3);
    await dave.resolveDispute(first, 'bob', 'expense_voided', 'Send it again, corrected');
    expect((await lineOf(d, 'charlie', first)).state).toBe('voided');

    // the same receipt and photo (the fingerprint of a voided expense is free again): pho for
    // alice only, beers for charlie, water for all three
    const second = await submit(d, [
      { itemIndex: 0, members: ['alice'] },
      { itemIndex: 1, members: ['charlie'] },
      { itemIndex: 2, members: ['alice', 'bob', 'charlie'] },
    ]);
    const bobCents = (await lineOf(d, 'bob', second)).cents;
    const charlieCents = (await lineOf(d, 'charlie', second)).cents;
    expect(bobCents).toBeLessThan(309n);
    expect(bobCents + charlieCents).not.toBe(309n + 350n);

    await run(d, 21);
    expect((await lineOf(d, 'bob', second)).state).toBe('paid');
    expect((await lineOf(d, 'charlie', second)).state).toBe('paid');
    expect(await aliceTrip(d)).toBe(before + bobCents + charlieCents);
  });
});
