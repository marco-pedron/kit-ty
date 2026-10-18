import { DEMO_TRIP_PARAMS, MEMBER_IDS, type ActorId } from '@kitty/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLightningNetwork } from '../dev-fakes/fake-wallet.js';
import type { Wallet } from '../wallet/types.js';
import { fakeTripChannels, seedTrip, startAgents, StaleRelayError } from './runtime.js';
import { loadRates, parseSeedState } from './seed-state.js';
import { MemoryRelay } from './test/memory-relay.js';

const silent = { info: () => {}, warn: () => {} };

function seedStateJson(): unknown {
  const members: Record<string, unknown> = {};
  for (const id of MEMBER_IDS)
    members[id] = {
      pubkey: `pk-${id}`,
      channels: [
        { kind: 'travel', peer: 'dave', channelId: `t-${id}`, usable: true },
        { kind: 'liquidity', peer: 'dave', channelId: `l-${id}`, usable: true },
      ],
    };
  members.dave = { channels: [{ kind: 'liquidity', peer: 'alice', channelId: 'l-alice' }] };
  return { createdAt: '2026-10-17T10:00:00Z', assetId: 'rgb:asset', members };
}

describe('seed state', () => {
  it('reads the asset and the two channels of each traveler with dave', () => {
    const s = parseSeedState(seedStateJson());
    expect(s.assetId).toBe('rgb:asset');
    expect(s.channels.bob).toEqual({ tripChannelId: 't-bob', liquidityChannelId: 'l-bob' });
  });

  it('rejects a traveler without both channels', () => {
    const raw = seedStateJson() as { members: Record<string, { channels: unknown[] }> };
    raw.members.charlie!.channels.pop();
    expect(() => parseSeedState(raw)).toThrow(/charlie has no travel and liquidity channel/);
  });

  it('reads the rates fixture as a RATE_SET body', () => {
    const r = loadRates();
    expect(r.rates.VND).toBe('26350');
    expect(r.source).toMatch(/not live market data/);
  });
});

describe('seedTrip', () => {
  beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
  const now = () => new Date('2026-10-17T10:00:00Z');

  function runtime() {
    const net = new FakeLightningNetwork();
    const relay = new MemoryRelay(net, now);
    const wallets = {} as Record<ActorId, Wallet>;
    for (const a of ['alice', 'bob', 'charlie', 'dave'] as const) wallets[a] = net.wallet(a);
    const rt = startAgents({ fakes: true, relay, wallets, log: silent, tickMs: 3_600_000 });
    const seed = { assetId: net.assetId, channels: fakeTripChannels(), rate: loadRates() };
    return { rt, relay, seed };
  }

  it('sets up the trip once and is a no-op on restart', async () => {
    const { rt, relay, seed } = runtime();
    await seedTrip(rt, seed, DEMO_TRIP_PARAMS, silent);
    const n = relay.events.length;
    expect(n).toBe(2 + 3 * 3);
    const trip = rt.dave.trip();
    expect(trip?.rate?.body.source).toBe(seed.rate.source);
    expect([...trip!.members.values()].every((m) => m.admitted && m.channelsReady)).toBe(true);
    await seedTrip(rt, seed, DEMO_TRIP_PARAMS, silent);
    expect(relay.events.length).toBe(n);
    rt.stop();
  });

  it('stops when the relay holds the trip of another seed', async () => {
    const { rt, seed } = runtime();
    await seedTrip(rt, seed, DEMO_TRIP_PARAMS, silent);
    await expect(
      seedTrip(rt, { ...seed, assetId: 'rgb:other' }, DEMO_TRIP_PARAMS, silent),
    ).rejects.toThrow(StaleRelayError);
    rt.stop();
  });

  it('writes the requested params into TRIP_CREATED', async () => {
    const { rt, seed } = runtime();
    const params = { ...DEMO_TRIP_PARAMS, silentAssentSeconds: 45, paymentDeadlineSeconds: 120 };
    await seedTrip(rt, seed, params, silent);
    expect(rt.dave.trip()?.params).toEqual(params);
    rt.stop();
  });

  it('stops with a demo:reset hint when the relay trip has other timers', async () => {
    const { rt, seed } = runtime();
    await seedTrip(rt, seed, DEMO_TRIP_PARAMS, silent);
    const live = { ...DEMO_TRIP_PARAMS, silentAssentSeconds: 45, paymentDeadlineSeconds: 120 };
    const run = seedTrip(rt, seed, live, silent);
    await expect(run).rejects.toThrow(StaleRelayError);
    await expect(run).rejects.toThrow(/pnpm demo:reset/);
    rt.stop();
  });
});
