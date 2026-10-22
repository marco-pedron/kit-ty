import {
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  type MemberId,
  type TripParams,
} from '@kitty/shared';
import { FakeLightningNetwork } from '../../dev-fakes/fake-wallet.js';
import { CoordinatorAgent } from '../dave.js';
import { MemberAgent } from '../member-agent.js';
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
  /** With `registry: true`: the travelers' seeds and the registry v2 transport. */
  registry: { seeds: Record<MemberId, Uint8Array>; transport: MemoryTransport } | null;
}

export interface TripAgents {
  agents: Record<MemberId, MemberAgent> & { dave: CoordinatorAgent };
  /** One tick of every agent, then waits for their payments. */
  tickAll: () => Promise<void>;
  registry: Demo['registry'];
}

/** The four agents on any RelayClient, and the trip set up through the flows. */
export async function setUpTrip(p: {
  net: FakeLightningNetwork;
  relay: RelayClient;
  now: () => Date;
  retryMs?: number;
  params?: Partial<TripParams>;
  backupQuietMs?: number;
  /** KITTY_REGISTRY=v2: the registry v2 next to the legacy log, set up after it. */
  registry?: boolean;
}): Promise<TripAgents> {
  const common = {
    relay: p.relay,
    verifier: fakeVerifier,
    now: p.now,
    ...(p.retryMs !== undefined && { retryMs: p.retryMs }),
    ...(p.backupQuietMs !== undefined && { backupQuietMs: p.backupQuietMs }),
  };
  const dave = new CoordinatorAgent({ ...common, wallet: p.net.wallet('dave') });
  const registry = p.registry
    ? {
        transport: new MemoryTransport(),
        seeds: Object.fromEntries(
          MEMBER_IDS.map((id) => [id, crypto.getRandomValues(new Uint8Array(64))]),
        ) as Record<MemberId, Uint8Array>,
      }
    : null;
  const travelers = Object.fromEntries(
    MEMBER_IDS.map((id) => {
      const wallet = p.net.wallet(id);
      const reg =
        registry &&
        new RegistryV2({
          displayName: id,
          seed: registry.seeds[id],
          wallet,
          transport: registry.transport,
          now: p.now,
        });
      return [id, new MemberAgent({ ...common, actor: id, wallet, ...(reg && { registry: reg }) })];
    }),
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
  if (registry !== null)
    await seedRegistryV2(
      new Map<MemberId | 'dave', MemberAgent>(Object.entries(agents) as [MemberId, MemberAgent][]),
      'vietnam-2026',
      'Vietnam 2026',
      p.net.assetId,
      { ...DEMO_TRIP_PARAMS, ...p.params },
    );
  const tickAll = async () => {
    for (const a of Object.values(agents)) await a.tick();
    for (const a of Object.values(agents)) await a.idle();
  };
  return { agents, tickAll, registry };
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
    registry?: boolean;
  } = {},
): Promise<Demo> {
  const net = new FakeLightningNetwork();
  const { now, advance } = manualClock();
  const relay = new MemoryRelay(net, now, { strict: opts.strict ?? true });
  const { agents, tickAll, registry } = await setUpTrip({
    net,
    relay,
    now,
    ...(opts.retryMs !== undefined && { retryMs: opts.retryMs }),
    ...(opts.params !== undefined && { params: opts.params }),
    ...(opts.backupQuietMs !== undefined && { backupQuietMs: opts.backupQuietMs }),
    ...(opts.registry !== undefined && { registry: opts.registry }),
  });
  return { net, relay, agents, advance, now, tickAll, registry };
}
