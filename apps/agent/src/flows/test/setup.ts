import {
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  type MemberId,
  type TripParams,
} from '@kitty/shared';
import { FakeLightningNetwork } from '../../dev-fakes/fake-wallet.js';
import { CoordinatorAgent } from '../dave.js';
import { LspAgent } from '../lsp-agent.js';
import { MemberAgent } from '../member-agent.js';
import { RegistryAgent } from '../registry-agent.js';
import { MemoryTransport } from '../registry-transport.js';
import { RegistryV2 } from '../registry-v2.js';
import { seedRegistryV2 } from '../runtime.js';
import type { RelayClient } from '../../relay/types.js';
import { MemoryRelay } from './memory-relay.js';

// TESTS ONLY: four agents on one fake Lightning network and one in-memory relay, a manual
// clock, and the trip of SPEC §6.1-6.2 set up through the flows themselves (what the seed of
// task B2 calls): dave creates the trip and the rate, each traveler joins, dave admits them
// and attests their channels.

export interface Demo {
  net: FakeLightningNetwork;
  relay: MemoryRelay;
  agents: Record<MemberId, MemberAgent> & { dave: CoordinatorAgent };
  /** Moves the clock forward. */
  advance: (seconds: number) => void;
  now: () => Date;
  /** One tick of every agent, then waits for their payments. */
  tickAll: () => Promise<void>;
}

export interface TripAgents {
  agents: Record<MemberId, MemberAgent> & { dave: CoordinatorAgent };
  /** One tick of every agent, then waits for their payments. */
  tickAll: () => Promise<void>;
}

/** The four agents on any RelayClient, and the trip set up through the flows. */
export async function setUpTrip(p: {
  net: FakeLightningNetwork;
  relay: RelayClient;
  now: () => Date;
  retryMs?: number;
  params?: Partial<TripParams>;
  backupQuietMs?: number;
}): Promise<TripAgents> {
  const common = {
    relay: p.relay,
    verifier: fakeVerifier,
    now: p.now,
    ...(p.retryMs !== undefined && { retryMs: p.retryMs }),
    ...(p.backupQuietMs !== undefined && { backupQuietMs: p.backupQuietMs }),
  };
  const dave = new CoordinatorAgent({ ...common, wallet: p.net.wallet('dave') });
  const travelers = Object.fromEntries(
    MEMBER_IDS.map((id) => [
      id,
      new MemberAgent({ ...common, actor: id, wallet: p.net.wallet(id) }),
    ]),
  ) as Record<MemberId, MemberAgent>;
  const agents = { ...travelers, dave };

  await dave.createTrip({
    name: 'Vietnam 2026',
    assetId: p.net.assetId,
    params: { ...DEMO_TRIP_PARAMS, ...p.params },
  });
  await dave.setRate({ asOf: '2026-10-17', source: 'infra/rates.json', rates: { VND: '26350' } });
  for (const id of MEMBER_IDS) {
    await travelers[id].joinTrip();
    await dave.admit(id);
    await dave.channelsReady(id, { tripChannelId: `trip-${id}`, liquidityChannelId: `liq-${id}` });
  }
  const tickAll = async () => {
    for (const a of Object.values(agents)) await a.tick();
    for (const a of Object.values(agents)) await a.idle();
  };
  return { agents, tickAll };
}

/** A manual clock, starting now. */
export function manualClock(): { now: () => Date; advance: (seconds: number) => void } {
  let t = Date.now();
  return {
    now: () => new Date(t),
    advance: (s) => {
      t += s * 1000;
    },
  };
}

export async function demo(
  opts: {
    strict?: boolean;
    retryMs?: number;
    params?: Partial<TripParams>;
    backupQuietMs?: number;
  } = {},
): Promise<Demo> {
  const net = new FakeLightningNetwork();
  const { now, advance } = manualClock();
  const relay = new MemoryRelay(net, now, { strict: opts.strict ?? true });
  const { agents, tickAll } = await setUpTrip({
    net,
    relay,
    now,
    ...(opts.retryMs !== undefined && { retryMs: opts.retryMs }),
    ...(opts.params !== undefined && { params: opts.params }),
    ...(opts.backupQuietMs !== undefined && { backupQuietMs: opts.backupQuietMs }),
  });
  return { net, relay, agents, advance, now, tickAll };
}

/** KITTY_REGISTRY=v2: three travelers on the registry only, dave's node as the LSP. */
export interface RegistryDemo {
  net: FakeLightningNetwork;
  relay: MemoryRelay;
  travelers: Record<MemberId, RegistryAgent>;
  lsp: LspAgent;
  seeds: Record<MemberId, Uint8Array>;
  transport: MemoryTransport;
  advance: (seconds: number) => void;
  now: () => Date;
  tickAll: () => Promise<void>;
}

/** The trip of the v2 demo, set up through the flows: alice creates it, bob and charlie join. */
export async function registryDemo(opts: { retryMs?: number } = {}): Promise<RegistryDemo> {
  const net = new FakeLightningNetwork();
  const { now, advance } = manualClock();
  const relay = new MemoryRelay(net, now, { strict: true });
  const transport = new MemoryTransport();
  const seeds = Object.fromEntries(
    MEMBER_IDS.map((id) => [id, crypto.getRandomValues(new Uint8Array(64))]),
  ) as Record<MemberId, Uint8Array>;
  const daveWallet = net.wallet('dave');
  const travelers = Object.fromEntries(
    MEMBER_IDS.map((id) => {
      const wallet = net.wallet(id);
      const registryOf = () =>
        new RegistryV2({ displayName: id, seed: seeds[id], wallet, transport, now });
      const registry = registryOf();
      return [
        id,
        new RegistryAgent({
          actor: id,
          wallet,
          registry,
          newRegistry: registryOf,
          relay,
          rate: () => ({ asOf: '2026-10-17', source: 'infra/rates.json', rates: { VND: '26350' } }),
          lspNodePubkey: () => daveWallet.nodePubkey(),
          now,
          ...(opts.retryMs !== undefined && { retryMs: opts.retryMs }),
        }),
      ];
    }),
  ) as Record<MemberId, RegistryAgent>;
  const lsp = new LspAgent({ wallet: daveWallet, targetCents: 3000n, now });
  await seedRegistryV2(
    new Map(Object.entries(travelers) as [MemberId, RegistryAgent][]),
    'vietnam-2026',
    'Vietnam 2026',
    net.assetId,
    DEMO_TRIP_PARAMS,
  );
  const tickAll = async () => {
    for (const a of Object.values(travelers)) await a.tick();
    await lsp.tick();
    for (const a of Object.values(travelers)) await a.idle();
    await lsp.idle();
  };
  await tickAll(); // every phone fetches the joins of the others
  return { net, relay, travelers, lsp, seeds, transport, advance, now, tickAll };
}
