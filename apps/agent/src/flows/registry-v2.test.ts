import { sha256Hex, type SplitAssignment } from '@kitty/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { FlowError } from './errors.js';
import type { MemberAgent } from './member-agent.js';
import { RegistryV2 } from './registry-v2.js';
import { registryVersion } from './runtime.js';
import { demo, type Demo } from './test/setup.js';

// KITTY_REGISTRY=v2 (step 3 and the double write of 22/10): the registry v2 next to the legacy
// log, its keys per trip, and the rules it adds to the app.

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');
/** alice and charlie only: bob owes nothing. */
const WITHOUT_BOB: SplitAssignment[] = [
  { itemIndex: 0, members: ['alice'] },
  { itemIndex: 1, members: ['charlie'] },
  { itemIndex: 2, members: ['alice', 'charlie'] },
];

function reg(a: MemberAgent): RegistryV2 {
  if (a.registry === null) throw new Error('no registry v2');
  return a.registry;
}

async function v2demo(): Promise<Demo> {
  const d = await demo({ registry: true });
  await d.tickAll();
  return d;
}

describe('KITTY_REGISTRY', () => {
  it('v1 by default; v2; anything else is refused', () => {
    expect(registryVersion(undefined)).toBe('v1');
    expect(registryVersion('')).toBe('v1');
    expect(registryVersion('v1')).toBe('v1');
    expect(registryVersion('v2')).toBe('v2');
    expect(() => registryVersion('v3')).toThrow(/v1 or v2/);
  });

  it('with v1 there is no registry v2 and no blocks', async () => {
    const d = await demo();
    expect(d.agents.alice.registry).toBeNull();
    await expect(d.agents.bob.blockMember('alice')).rejects.toThrow(/KITTY_REGISTRY=v2/);
  });
});

describe('registry v2 next to the legacy log', () => {
  it('the trip is in the registry too: three members, no coordinator, one key per trip', async () => {
    const d = await v2demo();
    const { alice, bob, charlie, dave } = d.agents;
    const view = reg(alice).view();
    expect(view?.rejected).toEqual([]);
    expect([...(view?.members.values() ?? [])].map((m) => m.displayName).sort()).toEqual([
      'alice',
      'bob',
      'charlie',
    ]);
    expect(dave.registry).toBeNull();
    for (const a of [alice, bob, charlie]) {
      // the NIP-06 key of the trip is not the legacy app key, and binds the member's node
      const pk = reg(a).pubkey;
      expect(pk).not.toBe(await a.authorPubkey());
      expect(view?.members.get(pk ?? '')?.nodePubkey).toBe(a.me()?.nodePubkey);
    }
  });

  it('double write: the dinner is in the registry, valid; bob pays after the silent assent', async () => {
    const d = await v2demo();
    const { alice, bob } = d.agents;
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll();
    d.advance(20);
    await d.tickAll();
    await d.tickAll();
    const legacy = bob.trip();
    const line = [...(legacy?.lines.values() ?? [])].find(
      (l) => l.debtorPubkey === bob.me()?.pubkey,
    );
    expect(line?.state).toBe('paid');
    await d.tickAll(); // the PAYMENT_MADE is mirrored
    const view = reg(alice).view();
    expect(view?.rejected).toEqual([]);
    const v2line = view && legacy && line ? reg(alice).lineOf(view, legacy, line) : null;
    expect(v2line).toMatchObject({ amount: 309n, state: 'paid' });
    // the invoices of a v2 trip last 48 h (plus a margin), not the legacy 3600 s
    const inv = alice.log.invoices.get(line?.bolt11 ?? '');
    expect(Date.parse(inv?.expiresAt ?? '') - Date.now()).toBeGreaterThan(48 * 3600 * 1000);
  });

  it('a block: "Ho pagato" refuses the expense and says why; the line is paid by hand only', async () => {
    const d = await v2demo();
    const { alice, bob } = d.agents;
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, PHOTO);
    await d.tickAll();

    const { warning } = await bob.blockMember('alice');
    expect(warning).toMatch(/counts towards excluding alice: with it, 1 of the 2 other active/);
    await d.tickAll();

    // the debt from before the block stays, but no automatic payment
    d.advance(20);
    await d.tickAll();
    const line = [...(bob.trip()?.lines.values() ?? [])].find(
      (l) => l.debtorPubkey === bob.me()?.pubkey,
    );
    expect(line?.state).toBe('due');
    expect(line && bob.decisionFor(line)?.reason).toMatch(/blocked: pay it by hand/);
    expect((await d.net.wallet('bob').balances()).tripOutboundCents).toBe(5000n);

    // a new expense between alice and bob: refused before any invoice is made
    const refused = alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, sha256Hex('2'));
    await expect(refused).rejects.toThrow(FlowError);
    await expect(refused).rejects.toThrow(/bob blocked alice/);
    // without bob it goes through
    await alice.submitExpense(DEMO_RECEIPT, WITHOUT_BOB, sha256Hex('3'));
    await d.tickAll();
    expect(reg(alice).view()?.rejected).toEqual([]);
    expect(reg(alice).view()?.expenses.size).toBe(2);

    await bob.unblockMember('alice');
    await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, sha256Hex('4'));
    expect(reg(alice).view()?.expenses.size).toBe(3);
  });

  it('after a restart a member finds its trip again from the seed alone', async () => {
    const d = await v2demo();
    const { bob } = d.agents;
    if (d.registry === null) throw new Error('no registry');
    const again = new RegistryV2({
      displayName: 'bob',
      seed: d.registry.seeds.bob,
      wallet: d.net.wallet('bob'),
      transport: d.registry.transport,
      now: d.now,
    });
    expect(await again.recover('vietnam-2026')).toBe(true);
    expect(again.pubkey).toBe(reg(bob).pubkey);
    expect(again.tripTag).toBe(reg(bob).tripTag);
    expect(again.isMember()).toBe(true);
    expect(await again.recover('another-trip')).toBe(true); // already set: no second trip
  });
});
