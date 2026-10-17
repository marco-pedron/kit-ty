import {
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  type ActorId,
  type MemberId,
} from '@kitty/shared';
import { FakeLightningNetwork } from '../../dev-fakes/fake-wallet.js';
import { MemberAgent } from '../member-agent.js';
import { publishEvent } from '../publish.js';
import { MemoryRelay } from './memory-relay.js';

// TESTS ONLY: four agents on one fake Lightning network and one in-memory relay, a manual
// clock, and the trip of SPEC §6.1-6.2 already set up (the A5b flows will publish this).

export const TRIP_ID = 'vietnam-2026';

export interface Demo {
  net: FakeLightningNetwork;
  relay: MemoryRelay;
  agents: Record<ActorId, MemberAgent>;
  /** Moves the clock forward. */
  advance: (seconds: number) => void;
  now: () => Date;
  /** One tick of every agent, then waits for their payments. */
  tickAll: () => Promise<void>;
}

export async function demo(opts: { strict?: boolean; retryMs?: number } = {}): Promise<Demo> {
  const net = new FakeLightningNetwork();
  let t = Date.now();
  const now = () => new Date(t);
  const relay = new MemoryRelay(net, now, { strict: opts.strict ?? true });
  const wallets = Object.fromEntries(
    (['alice', 'bob', 'charlie', 'dave'] as const).map((a) => [a, net.wallet(a)]),
  ) as Record<ActorId, ReturnType<FakeLightningNetwork['wallet']>>;
  const agents = Object.fromEntries(
    Object.entries(wallets).map(([actor, wallet]) => [
      actor,
      new MemberAgent({
        actor: actor as ActorId,
        wallet,
        relay,
        verifier: fakeVerifier,
        now,
        ...(opts.retryMs !== undefined && { retryMs: opts.retryMs }),
      }),
    ]),
  ) as Record<ActorId, MemberAgent>;

  const pub = (actor: ActorId) => ({ wallet: wallets[actor], relay, now });
  const dave = await wallets.dave.authorPubkey();
  await publishEvent(pub('dave'), TRIP_ID, 'TRIP_CREATED', {
    name: 'Vietnam 2026',
    assetId: net.assetId,
    params: DEMO_TRIP_PARAMS,
    coordinatorPubkey: dave,
  });
  await publishEvent(pub('dave'), TRIP_ID, 'RATE_SET', {
    asOf: '2026-10-17',
    source: 'infra/rates.json',
    rates: { VND: '26350' },
  });
  for (const id of MEMBER_IDS as readonly MemberId[]) {
    const w = wallets[id];
    const appPubkey = await w.authorPubkey();
    await publishEvent(pub(id), TRIP_ID, 'MEMBER_JOINED', {
      displayName: id,
      memberId: id,
      appPubkey,
      nodePubkey: await w.nodePubkey(),
      bindInvoice: await w.bindInvoice(appPubkey),
      policy: { autoPayLimitCents: 2000n, dailyCapCents: 6000n, payUpheldDisputes: false },
    });
    await publishEvent(pub('dave'), TRIP_ID, 'MEMBER_ADMITTED', { memberPubkey: appPubkey });
    await publishEvent(pub('dave'), TRIP_ID, 'CHANNELS_READY', {
      memberPubkey: appPubkey,
      tripChannelId: `trip-${id}`,
      liquidityChannelId: `liq-${id}`,
    });
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
