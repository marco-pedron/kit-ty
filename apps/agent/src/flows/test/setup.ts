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

export async function demo(
  opts: { strict?: boolean; retryMs?: number; params?: Partial<TripParams> } = {},
): Promise<Demo> {
  const net = new FakeLightningNetwork();
  let t = Date.now();
  const now = () => new Date(t);
  const relay = new MemoryRelay(net, now, { strict: opts.strict ?? true });
  const common = {
    relay,
    verifier: fakeVerifier,
    now,
    ...(opts.retryMs !== undefined && { retryMs: opts.retryMs }),
  };
  const dave = new CoordinatorAgent({ ...common, wallet: net.wallet('dave') });
  const travelers = Object.fromEntries(
    MEMBER_IDS.map((id) => [id, new MemberAgent({ ...common, actor: id, wallet: net.wallet(id) })]),
  ) as Record<MemberId, MemberAgent>;
  const agents = { ...travelers, dave };

  await dave.createTrip({
    name: 'Vietnam 2026',
    assetId: net.assetId,
    params: { ...DEMO_TRIP_PARAMS, ...opts.params },
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
  return {
    net,
    relay,
    agents,
    advance: (s) => {
      t += s * 1000;
    },
    now,
    tickAll,
  };
}
