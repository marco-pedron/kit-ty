import { sha256Hex, type SplitAssignment } from '@kitty/shared';
import type { registry as v2 } from '@kitty/ledger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { FakeLightningNetwork } from '../dev-fakes/fake-wallet.js';
import { FlowError } from './errors.js';
import { LspAgent, lspLiquidityPlan } from './lsp-agent.js';
import { RegistryV2 } from './registry-v2.js';
import { registryVersion, startAgents } from './runtime.js';
import { MemoryRelay } from './test/memory-relay.js';
import { demo, manualClock, registryDemo, type RegistryDemo } from './test/setup.js';

// KITTY_REGISTRY=v2 since 23/10: the travelers read and write only the registry v2 (no double
// write), nobody coordinates, dave's node is only the LSP. The story of the v2 demo: bob pays
// after the silent assent, charlie contests and then withdraws by approving (C3) and pays,
// then everyone leaves closing their own channels, and the trip is closed.

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const PHOTO = sha256Hex('dinner photo');
/** alice and charlie only: bob owes nothing. */
const WITHOUT_BOB: SplitAssignment[] = [
  { itemIndex: 0, members: ['alice'] },
  { itemIndex: 1, members: ['charlie'] },
  { itemIndex: 2, members: ['alice', 'charlie'] },
];

function lineOf(d: RegistryDemo, expenseId: string, debtor: 'bob' | 'charlie'): v2.RegistryLine {
  const a = d.travelers[debtor];
  const { trip, me } = a.requireMember();
  return a.lineOf(trip, expenseId, me.pubkey);
}

async function dinner(d: RegistryDemo): Promise<string> {
  const { expenseId } = await d.travelers.alice.submitExpense(
    DEMO_RECEIPT,
    DEMO_SPLIT.assignments,
    PHOTO,
  );
  await d.tickAll();
  return expenseId;
}

const balance = async (d: RegistryDemo, who: 'alice' | 'bob' | 'charlie') =>
  d.net.wallet(who).balances();

describe('KITTY_REGISTRY', () => {
  it('v1 by default; v2; anything else is refused', () => {
    expect(registryVersion(undefined)).toBe('v1');
    expect(registryVersion('')).toBe('v1');
    expect(registryVersion('v1')).toBe('v1');
    expect(registryVersion('v2')).toBe('v2');
    expect(() => registryVersion('v3')).toThrow(/v1 or v2/);
  });

  it('with v1 nothing changes, and there are no blocks', async () => {
    const d = await demo();
    expect(d.agents.alice.registry).toBeNull();
    await expect(d.agents.bob.blockMember('alice')).rejects.toThrow(/KITTY_REGISTRY=v2/);
  });

  it('with v2 the runtime has the travelers and the LSP, and no coordinator', () => {
    const net = new FakeLightningNetwork();
    const { now } = manualClock();
    const wallets = {
      alice: net.wallet('alice'),
      bob: net.wallet('bob'),
      charlie: net.wallet('charlie'),
      dave: net.wallet('dave'),
    };
    const seeds = {
      alice: new Uint8Array(64).fill(1),
      bob: new Uint8Array(64).fill(2),
      charlie: new Uint8Array(64).fill(3),
    };
    const rt = startAgents({
      fakes: true,
      relay: new MemoryRelay(net, now),
      wallets,
      log: { info: () => undefined, warn: () => undefined },
      tickMs: 3_600_000,
      registry: { seeds },
    });
    expect(rt.registry).toBe('v2');
    expect(rt.dave).toBeUndefined();
    expect(rt.agents.size).toBe(0);
    expect([...(rt.v2?.travelers.keys() ?? [])]).toEqual(['alice', 'bob', 'charlie']);
    expect(rt.v2?.lsp).toBeInstanceOf(LspAgent);
    rt.stop();
  });
});

describe('the trip in the registry v2 only', () => {
  it('three members with one key per trip, each bound to its node; the LSP is not in it', async () => {
    const d = await registryDemo();
    const view = d.travelers.alice.view();
    expect(view?.rejected).toEqual([]);
    expect([...(view?.members.values() ?? [])].map((m) => m.displayName).sort()).toEqual([
      'alice',
      'bob',
      'charlie',
    ]);
    for (const id of ['alice', 'bob', 'charlie'] as const) {
      const a = d.travelers[id];
      expect(view?.members.get(a.registry.pubkey ?? '')?.nodePubkey).toBe(
        await d.net.wallet(id).nodePubkey(),
      );
    }
    const lspNode = await d.net.wallet('dave').nodePubkey();
    expect([...(view?.members.values() ?? [])].some((m) => m.nodePubkey === lspNode)).toBe(false);
    // nothing goes through the legacy log
    expect(d.relay.events).toEqual([]);
  });

  it('after a restart a member finds its trip again from the seed alone', async () => {
    const d = await registryDemo();
    const again = new RegistryV2({
      displayName: 'bob',
      seed: d.seeds.bob,
      wallet: d.net.wallet('bob'),
      transport: d.transport,
      now: d.now,
    });
    expect(await again.recover('vietnam-2026')).toBe(true);
    expect(again.pubkey).toBe(d.travelers.bob.registry.pubkey);
    expect(again.tripTag).toBe(d.travelers.bob.registry.tripTag);
    expect(again.isMember()).toBe(true);
  });
});

describe('the story of the v2 demo', () => {
  it('bob pays after the silent assent; charlie contests, withdraws (C3) and pays', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    expect(lineOf(d, id, 'bob')).toMatchObject({ amount: 309n, state: 'awaiting_decision' });
    expect(lineOf(d, id, 'charlie')).toMatchObject({ amount: 350n, state: 'awaiting_decision' });

    await d.travelers.charlie.decide(id, 'contest', 'I only had water');
    expect(lineOf(d, id, 'charlie').state).toBe('contested');

    d.advance(20);
    await d.tickAll();
    await d.tickAll();
    const bobLine = lineOf(d, id, 'bob');
    expect(bobLine.state).toBe('paid');
    expect(d.travelers.bob.activity()[0]?.text).toMatch(
      /paid 3\.09 to alice: .*no objection in 20 s, under your limit of 20\.00/,
    );
    expect((await balance(d, 'bob')).tripOutboundCents).toBe(4691n);
    // a contested line is never paid automatically
    expect(lineOf(d, id, 'charlie').state).toBe('contested');
    expect((await balance(d, 'charlie')).tripOutboundCents).toBe(5000n);

    // charlie has seen the line again: he approves, which withdraws the contest (C3)
    const line = await d.travelers.charlie.decide(id, 'approve');
    expect(line).toMatchObject({ state: 'due', approvedExplicitly: true });
    await d.tickAll();
    await d.tickAll();
    expect(lineOf(d, id, 'charlie').state).toBe('paid');
    expect((await balance(d, 'charlie')).tripOutboundCents).toBe(4650n);
    expect((await balance(d, 'alice')).tripOutboundCents).toBe(5659n);
    // the invoices of a v2 trip last 48 h (plus a margin)
    const inv = d.travelers.alice.registry.invoice(lineOf(d, id, 'bob').invoices[0] ?? '');
    expect(Date.parse(inv?.expiresAt ?? '') - d.now().getTime()).toBeGreaterThan(48 * 3600_000);
  });

  it('then every member leaves, closing its own channels with the LSP: the trip is closed', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    d.advance(20);
    await d.tickAll();
    await d.travelers.charlie.decide(id, 'approve');
    await d.tickAll();
    await d.tickAll();

    for (const who of ['bob', 'charlie', 'alice'] as const) {
      const before = await balance(d, who);
      const r = await d.travelers[who].leave();
      expect(r.closingTxids).toHaveLength(2);
      expect(r.warning).toBeNull();
      const after = await balance(d, who);
      expect(after.tripOutboundCents).toBe(0n);
      expect(after.onchainCents).toBe(before.onchainCents + before.tripOutboundCents);
    }
    await d.tickAll();
    for (const who of ['alice', 'bob', 'charlie'] as const) {
      const view = d.travelers[who].view();
      expect(view?.finished).toBe(true);
      expect(view?.rejected).toEqual([]);
    }
    expect(await d.net.wallet('dave').peerChannels()).toEqual([]);
  });

  it('nobody leaves with a known debt, contested lines included', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    await d.travelers.charlie.decide(id, 'contest', 'I only had water');
    await expect(d.travelers.charlie.leave()).rejects.toThrow(/still owe 1 line/);
    expect((await balance(d, 'charlie')).tripOutboundCents).toBe(5000n);
    // alice can leave with credits: she is warned they will come on-chain only
    const r = await d.travelers.alice.leave();
    expect(r.warning).toMatch(/still owed 6\.59/);
  });
});

describe('contested lines decided by the others [23/10, provisional]', () => {
  it('bob is the only voter: "due" makes it due, but charlie must approve before it is paid', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    await d.travelers.charlie.decide(id, 'contest', 'I only had water');
    await expect(d.travelers.alice.vote(id, 'charlie', 'voided')).rejects.toThrow(
      /creditor and the debtor/,
    );
    const voted = await d.travelers.bob.vote(id, 'charlie', 'due');
    expect(voted).toMatchObject({ state: 'due', group: { outcome: 'due' } });
    d.advance(60);
    await d.tickAll();
    expect(lineOf(d, id, 'charlie').state).toBe('due');
    const charlieLine = lineOf(d, id, 'charlie');
    expect(d.travelers.charlie.decisionFor(charlieLine)?.reason).toMatch(
      /group decided you owe 3\.50 to alice: approve it/,
    );
    await d.travelers.charlie.decide(id, 'approve');
    await d.tickAll();
    await d.tickAll();
    expect(lineOf(d, id, 'charlie').state).toBe('paid');
  });

  it('"voided": charlie owes nothing and can leave', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    await d.travelers.charlie.decide(id, 'contest', 'I only had water');
    await d.travelers.bob.vote(id, 'charlie', 'voided');
    await d.tickAll();
    expect(lineOf(d, id, 'charlie').state).toBe('voided');
    await expect(d.travelers.bob.vote(id, 'charlie', 'due')).rejects.toThrow(/already decided/);
    const r = await d.travelers.charlie.leave();
    expect(r.closingTxids).toHaveLength(2);
  });
});

describe('blocks', () => {
  it('"Ho pagato" refuses the expense and says why; the line is paid by hand only', async () => {
    const d = await registryDemo();
    const id = await dinner(d);
    const { warning } = await d.travelers.bob.blockMember('alice');
    expect(warning).toMatch(/counts towards excluding alice: with it, 1 of the 2 other active/);
    d.advance(20);
    await d.tickAll();
    const line = lineOf(d, id, 'bob');
    expect(line.state).toBe('manual_only');
    expect(d.travelers.bob.decisionFor(line)?.reason).toMatch(/blocked: pay 3\.09 by hand/);
    expect((await balance(d, 'bob')).tripOutboundCents).toBe(5000n);

    const refused = d.travelers.alice.submitExpense(
      DEMO_RECEIPT,
      DEMO_SPLIT.assignments,
      '2'.repeat(64),
    );
    await expect(refused).rejects.toThrow(FlowError);
    await expect(refused).rejects.toThrow(/bob blocked alice/);
    await d.travelers.alice.submitExpense(DEMO_RECEIPT, WITHOUT_BOB, '3'.repeat(64));
    expect(d.travelers.alice.view()?.expenses.size).toBe(2);
    await d.travelers.bob.unblockMember('alice');
    await d.travelers.alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, '4'.repeat(64));
    expect(d.travelers.alice.view()?.rejected).toEqual([]);
  });
});

describe('the LSP manages its liquidity from its own channels', () => {
  const ch = (
    peer: string,
    local: bigint,
    status: 'Opened' | 'Opening' | 'Closing' = 'Opened',
  ) => ({
    channelId: `${peer}-${local}`,
    peerPubkey: peer,
    status,
    usable: status === 'Opened',
    localCents: local,
    remoteCents: 0n,
  });

  it('below the threshold, up to L; peers opening or closing a channel are left alone', () => {
    expect(
      lspLiquidityPlan(
        [
          ch('a', 2341n),
          ch('b', 600n),
          ch('b', 200n),
          ch('c', 0n, 'Closing'),
          ch('d', 0n, 'Opening'),
        ],
        1000n,
        3000n,
      ),
    ).toEqual([
      { peerPubkey: 'a', inboundCents: 2341n, openCents: 0n },
      { peerPubkey: 'b', inboundCents: 800n, openCents: 2200n },
    ]);
  });

  it('opens one channel when a member can receive too little, without the registry', async () => {
    const d = await registryDemo();
    const bob = d.net.account('bob');
    bob.inboundCents = 500n;
    await d.lsp.tick();
    await d.lsp.idle();
    expect(bob.inboundCents).toBe(3000n);
    expect(d.lsp.operations()[0]).toMatchObject({ kind: 'opening_liquidity', status: 'done' });
    await d.lsp.tick();
    await d.lsp.idle();
    expect(d.lsp.operations()).toHaveLength(1);
  });
});
