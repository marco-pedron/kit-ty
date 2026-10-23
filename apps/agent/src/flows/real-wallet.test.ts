import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorIdSchema,
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  sha256Hex,
  signatureVerifier,
  type ActorId,
} from '@kitty/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
// The real relay, in memory (tests only: apps never import each other).
import { openRelayDb } from '../../../relay/src/db.js';
import { buildRelay } from '../../../relay/src/server.js';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { createRelayClient } from '../relay/http-client.js';
import { RlnWallet } from '../wallet/rln-wallet.js';
import { loadMemberWalletOptions } from '../wallet/secrets.js';
import type { Wallet } from '../wallet/types.js';
import { seedTrip, startAgents, StaleRelayError } from './runtime.js';
import { loadRates, loadSeedState } from './seed-state.js';
import { RlnNetwork } from './test/rln-network.js';
import { manualClock } from './test/setup.js';

// A5 ★3 without Docker: what index.ts does with KITTY_FAKES unset. The wallets are the REAL
// RlnWallet (B3), built from seed files by loadMemberWalletOptions; events are signed with
// ed25519 and checked with the real signatureVerifier, by the real relay over HTTP (C1, C2).
// Only the four RLN nodes are simulated (test/rln-network.ts). The proof on the real regtest
// stack is scripts/check-real.ts.

const ASSET = 'rgb:sim-dusd';
const running: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
});

/** The files the seed (B2) writes, in a temp dir: mnemonics and the non-secret state. */
function seedFiles(net: RlnNetwork): { secretsFile: string; seedStateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-seed-'));
  const nodes: Record<string, { mnemonic: string }> = {};
  const members: Record<string, unknown> = {};
  for (const a of ActorIdSchema.options) {
    nodes[a] = { mnemonic: `${a} test mnemonic regtest only` };
    members[a] = {
      pubkey: net.nodePubkey[a],
      channels:
        a === 'dave'
          ? []
          : [
              { kind: 'travel', peer: 'dave', channelId: `chan-trip-${a}` },
              { kind: 'liquidity', peer: 'dave', channelId: `chan-liq-${a}` },
            ],
    };
  }
  const secretsFile = join(dir, 'nodes.json');
  const seedStateFile = join(dir, 'seed-state.json');
  writeFileSync(secretsFile, JSON.stringify({ nodes }));
  writeFileSync(seedStateFile, JSON.stringify({ assetId: ASSET, members }));
  return { secretsFile, seedStateFile };
}

async function realStack() {
  const { now, advance } = manualClock();
  const net = new RlnNetwork(ASSET, () => now().getTime());
  const files = seedFiles(net);
  const relayApp = buildRelay({
    logger: false,
    db: openRelayDb(':memory:'),
    now,
    deps: { verify: signatureVerifier, decodeInvoice: (b) => net.decode(b) },
  });
  running.push(relayApp);
  const relay = createRelayClient({
    baseUrl: await relayApp.listen({ host: '127.0.0.1', port: 0 }),
    timeoutMs: 5_000,
  });
  const wallets = {} as Record<ActorId, Wallet>;
  for (const a of ActorIdSchema.options) {
    const opts = loadMemberWalletOptions(a, { nodeUrl: `http://rln-${a}.sim`, ...files });
    wallets[a] = new RlnWallet({ ...opts, fetch: net.fetchFor(a), now: () => now().getTime() });
  }
  const log = { info: () => {}, warn: () => {} };
  const rt = startAgents({ fakes: false, relay, wallets, log, now, tickMs: 3_600_000 });
  const seed = { ...loadSeedState(files.seedStateFile), rate: loadRates() };
  const tickAll = async () => {
    for (const a of rt.agents.values()) await a.tick();
    for (const a of rt.agents.values()) await a.idle();
  };
  return { net, rt, seed, log, advance, tickAll };
}

describe('A5 on the real RlnWallet (simulated nodes)', () => {
  it('sets up the trip from the seed files, and bob pays alice over Lightning', async () => {
    const s = await realStack();
    await seedTrip(s.rt, s.seed, DEMO_TRIP_PARAMS, s.log);
    const { alice, bob, charlie } = Object.fromEntries(s.rt.agents) as Record<
      ActorId,
      NonNullable<ReturnType<typeof s.rt.agents.get>>
    >;

    // The trip: asset of the seed, rate of the fixture, members bound to their real nodes.
    const trip = s.rt.dave!.trip()!;
    expect(trip.assetId).toBe(ASSET);
    expect(trip.rate?.body.rates.VND).toBe('26350');
    for (const id of MEMBER_IDS) {
      const m = [...trip.members.values()].find((x) => x.memberId === id)!;
      expect(m).toMatchObject({
        admitted: true,
        channelsReady: true,
        nodePubkey: s.net.nodePubkey[id],
      });
    }

    await s.tickAll();
    const e = await alice!.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, sha256Hex('photo'));
    const expenseId = (e.signed.inner.body as { expenseId: string }).expenseId;
    await s.tickAll(); // LINE_SEEN of bob and charlie
    await charlie!.decide(expenseId, 'contest', 'I only had water');
    s.advance(20); // silent assent: bob's agent pays
    await s.tickAll();
    await s.tickAll();

    const bobLine = [...alice!.trip()!.lines.values()].find(
      (l) => l.debtorPubkey === bob!.me()?.pubkey,
    )!;
    expect(bobLine).toMatchObject({ cents: 309n, state: 'paid' });
    // The preimage published in PAYMENT_MADE is the node's, and opens the invoice's hash.
    const paid = bobLine.payment as { paymentHash: string; preimage: string };
    expect(sha256Hex(Buffer.from(paid.preimage, 'hex'))).toBe(paid.paymentHash);
    expect(s.net.decode(bobLine.bolt11).paymentHash).toBe(paid.paymentHash);
    expect(bob!.activity()[0]?.proof).toEqual({ rail: 'ln', paymentHash: paid.paymentHash });
    // DUSD moved on the simulated channels: bob 50.00 → 46.91 out, alice +3.09 out.
    expect(s.net.balance.bob.outbound).toBe(4691);
    expect(s.net.balance.alice.outbound).toBe(5309);
    // Every agent accepted every ed25519 signature and has the same head.
    const heads = new Set([...s.rt.agents.values()].map((a) => a.log.health().headHash));
    expect(heads.size).toBe(1);
    for (const a of s.rt.agents.values()) expect(a.log.divergence).toBeNull();
    s.rt.stop();
  });

  it('a restart with the same seed adds nothing; another seed stops with a clear error', async () => {
    const s = await realStack();
    await seedTrip(s.rt, s.seed, DEMO_TRIP_PARAMS, s.log);
    const before = s.rt.dave!.log.events.length;
    await seedTrip(s.rt, s.seed, DEMO_TRIP_PARAMS, s.log);
    await s.rt.dave!.sync();
    expect(s.rt.dave!.log.events.length).toBe(before);
    await expect(
      seedTrip(s.rt, { ...s.seed, assetId: 'rgb:new-seed' }, DEMO_TRIP_PARAMS, s.log),
    ).rejects.toThrow(
      new StaleRelayError(
        'the relay holds the trip of a previous seed (asset rgb:sim-dusd, this seed rgb:new-seed): wipe the relay database (RELAY_DB) and restart',
      ),
    );
    s.rt.stop();
  });
});
