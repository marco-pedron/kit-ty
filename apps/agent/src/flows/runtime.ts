import {
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  signatureVerifier,
  type ActorId,
  type EventBody,
} from '@kitty/shared';
import type { RelayClient } from '../relay/types.js';
import type { Wallet } from '../wallet/types.js';
import { CoordinatorAgent } from './dave.js';
import { apiErrorOf } from './errors.js';
import { MemberAgent } from './member-agent.js';
import { loadRates, type TripChannels } from './seed-state.js';

// The running agents of the process (SPEC §14): one per actor, each with ONLY its own wallet,
// all on the same relay client, ticking every second. The routes (task C3) read and act through
// `agents`.

export interface AgentRuntime {
  agents: Map<ActorId, MemberAgent>;
  dave: CoordinatorAgent;
  stop(): void;
}

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

/** SPEC §12: back a node up once it has been quiet for 10 s after a change. */
export const BACKUP_QUIET_MS = 10_000;

export function startAgents(p: {
  fakes: boolean;
  relay: RelayClient;
  wallets: Record<ActorId, Wallet>;
  log: Log;
  tickMs?: number;
  /** Clock of the agents (tests); default the wall clock. */
  now?: () => Date;
  /** B6: quiet time before a backup; default BACKUP_QUIET_MS. */
  backupQuietMs?: number;
}): AgentRuntime {
  // FakeWallet signs with fakeSign; the real wallet (B3) with ed25519 (B4).
  const verifier = p.fakes ? fakeVerifier : signatureVerifier;
  const common = { relay: p.relay, verifier, ...(p.now !== undefined && { now: p.now }) };
  // B6: no automatic backup of dave's node. Once in ~20 lock → unlock cycles RLN d4762ac hung
  // after the unlock on dave's node, the hub every payment goes through (docs/status/b.md, B6).
  const dave = new CoordinatorAgent({ ...common, wallet: p.wallets.dave });
  const agents = new Map<ActorId, MemberAgent>([['dave', dave]]);
  // B6: each traveler's node is backed up 10 s after it changed (SPEC §12)
  const backupQuietMs = p.backupQuietMs ?? BACKUP_QUIET_MS;
  for (const id of MEMBER_IDS)
    agents.set(id, new MemberAgent({ ...common, actor: id, wallet: p.wallets[id], backupQuietMs }));

  const lastError = new Map<ActorId, string>();
  const timer = setInterval(() => {
    for (const [actor, agent] of agents) {
      agent.tick().then(
        () => {
          if (lastError.delete(actor)) p.log.info(`agent ${actor}: back to normal`);
        },
        (err: unknown) => {
          // Logged once per distinct error, not every second.
          const e = apiErrorOf(err);
          if (lastError.get(actor) === e.message) return;
          lastError.set(actor, e.message);
          p.log.warn(`agent ${actor}: ${e.code} ${e.message}. ${e.action}`);
        },
      );
    }
  }, p.tickMs ?? 1_000);
  return { agents, dave, stop: () => clearInterval(timer) };
}

/** The trip of SPEC §6.1-6.2 does not match this seed: retrying cannot fix it. */
export class StaleRelayError extends Error {}

/**
 * Sets up the trip of SPEC §6.1-6.2 on the relay: TRIP_CREATED, RATE_SET, then for each traveler
 * MEMBER_JOINED, MEMBER_ADMITTED and CHANNELS_READY. Every step is skipped if already on the
 * relay, so a restart (or a crash halfway) resumes where it stopped. With the real wallet the
 * asset and channels come from the seed (B2); with KITTY_FAKES=1 from the fake network.
 * Retries until the relay answers; throws StaleRelayError if the relay holds another seed's trip.
 */
export async function seedTrip(
  rt: AgentRuntime,
  seed: { assetId: string; channels: TripChannels; rate: EventBody<'RATE_SET'> },
  log: Log,
): Promise<void> {
  for (;;) {
    try {
      await rt.dave.sync();
      let trip = rt.dave.trip();
      if (trip !== null && trip.assetId !== seed.assetId)
        throw new StaleRelayError(
          `the relay holds the trip of a previous seed (asset ${trip.assetId}, this seed ${seed.assetId}): wipe the relay database (RELAY_DB) and restart`,
        );
      if (trip === null)
        trip = await rt.dave.createTrip({
          name: 'Vietnam 2026',
          assetId: seed.assetId,
          params: DEMO_TRIP_PARAMS,
        });
      if (trip.rate === null) await rt.dave.setRate(seed.rate);
      for (const id of MEMBER_IDS) {
        await rt.agents.get(id)?.joinTrip();
        const member = await rt.dave.admit(id);
        if (!member.channelsReady) await rt.dave.channelsReady(id, seed.channels[id]);
      }
      log.info(`trip "${trip.name}" ready on the relay (asset ${seed.assetId})`);
      return;
    } catch (err) {
      if (err instanceof StaleRelayError) throw err;
      const e = apiErrorOf(err);
      log.warn(`trip setup: ${e.code} ${e.message}; retrying in 2 s`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** KITTY_FAKES=1 only: the channel ids of the fake network. */
export function fakeTripChannels(): TripChannels {
  const c = {} as TripChannels;
  for (const id of MEMBER_IDS)
    c[id] = { tripChannelId: `fake-trip-${id}`, liquidityChannelId: `fake-liq-${id}` };
  return c;
}

/**
 * @deprecated Use {@link seedTrip} with {@link fakeTripChannels}: same trip, one code path for
 * the fakes and the real seed. Kept so existing callers compile.
 */
export function seedFakeTrip(rt: AgentRuntime, assetId: string, log: Log): Promise<void> {
  return seedTrip(rt, { assetId, channels: fakeTripChannels(), rate: loadRates() }, log);
}
