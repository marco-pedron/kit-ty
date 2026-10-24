import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  registry as fmt,
  signatureVerifier,
  type ActorId,
  type EventBody,
  type MemberId,
  type TripParams,
} from '@kitty/shared';
import { upheldDeadlineSeconds } from '@kitty/ledger';
import type { RelayClient } from '../relay/types.js';
import type { Wallet } from '../wallet/types.js';
import { CoordinatorAgent } from './dave.js';
import { apiErrorOf } from './errors.js';
import { LspAgent } from './lsp-agent.js';
import { MemberAgent } from './member-agent.js';
import { RegistryAgent, type SavedRate } from './registry-agent.js';
import {
  MemoryTransport,
  type RegistryStore,
  type RegistryTransport,
} from './registry-transport.js';
import { RegistryV2 } from './registry-v2.js';
import { loadRates, type TripChannels } from './seed-state.js';

// The running agents of the process (SPEC §14): one per actor, each with ONLY its own wallet,
// ticking every second. v1: one MemberAgent per actor on the relay, dave the coordinator.
// v2 (23/10): one RegistryAgent per traveler on the registry v2 only, and dave's node as the
// LSP (LspAgent), outside the registry. The routes (task C3) read and act through them.

export interface AgentRuntime {
  /** v1: every actor's agent. Empty with v2 (see `v2`). */
  agents: Map<ActorId, MemberAgent>;
  /** v1: the coordinator. Undefined with v2: nobody coordinates. */
  dave?: CoordinatorAgent;
  /** KITTY_REGISTRY: v1 (or unset) = the legacy log; v2 = the registry v2 only. */
  registry?: 'v1' | 'v2';
  v2?: RegistryRuntime;
  stop(): void;
}

/** KITTY_REGISTRY=v2: the travelers on the registry and the LSP. */
export interface RegistryRuntime {
  travelers: Map<MemberId, RegistryAgent>;
  lsp: LspAgent;
  /** Tests: the one in-process transport they share. With relays each traveler has its own. */
  transport?: RegistryTransport;
  /** What the UI shows of the trip (D, L, labels); the rules are the registry's TripParams. */
  params: TripParams;
}

/** KITTY_REGISTRY, v1 by default. */
export function registryVersion(value: string | undefined): 'v1' | 'v2' {
  if (value === undefined || value === '' || value === 'v1') return 'v1';
  if (value === 'v2') return 'v2';
  throw new Error(`KITTY_REGISTRY must be v1 or v2, not "${value}"`);
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
  /**
   * KITTY_REGISTRY=v2: each traveler's BIP-39 seed (the registry keys are derived from it,
   * NIP-06), the transport of each phone (Nostr relays, step 4; default one in-process
   * transport), its local copy (default in memory), the rate each phone saved, the UI
   * parameters of the trip and the checkpoint timing. Unset: v1.
   */
  registry?: {
    seeds: Record<MemberId, Uint8Array>;
    transport?: RegistryTransport;
    transportFor?: (id: MemberId) => RegistryTransport;
    storeFor?: (id: MemberId) => RegistryStore;
    checkpointQuietMs?: number;
    checkpointEveryMs?: number;
    rate?: () => SavedRate;
    params?: TripParams;
    retryMs?: number;
  };
}): AgentRuntime {
  if (p.registry !== undefined) return startRegistryAgents({ ...p, registry: p.registry });
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
  const timer = tickEverySecond(agents, p.log, p.tickMs);
  return { agents, dave, registry: 'v1', stop: () => clearInterval(timer) };
}

/** Every agent's tick, every second; an error is logged once until it changes. */
function tickEverySecond(
  agents: ReadonlyMap<ActorId, { tick(): Promise<void> }>,
  log: Log,
  tickMs = 1_000,
): ReturnType<typeof setInterval> {
  const lastError = new Map<ActorId, string>();
  return setInterval(() => {
    for (const [actor, agent] of agents) {
      agent.tick().then(
        () => {
          if (lastError.delete(actor)) log.info(`agent ${actor}: back to normal`);
        },
        (err: unknown) => {
          // Logged once per distinct error, not every second.
          const e = apiErrorOf(err);
          if (lastError.get(actor) === e.message) return;
          lastError.set(actor, e.message);
          log.warn(`agent ${actor}: ${e.code} ${e.message}. ${e.action}`);
        },
      );
    }
  }, tickMs);
}

/**
 * KITTY_REGISTRY=v2 (23/10): each traveler reads and writes only the registry v2; dave's node is
 * the LSP and his agent only manages its liquidity from its channels. Nothing goes through the
 * legacy log; the relay keeps only the encrypted node backups (SPEC §12).
 */
function startRegistryAgents(
  p: Parameters<typeof startAgents>[0] & {
    registry: NonNullable<Parameters<typeof startAgents>[0]['registry']>;
  },
): AgentRuntime {
  const now = p.now ?? (() => new Date());
  const shared = p.registry.transport ?? new MemoryTransport();
  const transportFor = p.registry.transportFor ?? (() => shared);
  const params = p.registry.params ?? DEMO_TRIP_PARAMS;
  const rate = p.registry.rate ?? loadRates;
  const lspNode = p.wallets.dave.nodePubkey();
  // Answered once the node is up; until then a leave fails and is retried.
  lspNode.catch(() => undefined);
  const travelers = new Map<MemberId, RegistryAgent>();
  for (const id of MEMBER_IDS) {
    const wallet = p.wallets[id];
    const reg = p.registry;
    const transport = transportFor(id);
    /** This phone's registry; `fresh`: a new install with nothing on disk (lose-phone). */
    const registryOf = (fresh: boolean) => {
      const store = reg.storeFor?.(id);
      if (fresh) store?.wipe();
      return new RegistryV2({
        displayName: id,
        seed: reg.seeds[id],
        wallet,
        transport,
        now,
        ...(store && { store }),
      });
    };
    travelers.set(
      id,
      new RegistryAgent({
        actor: id,
        wallet,
        registry: registryOf(false),
        newRegistry: () => registryOf(true),
        relay: p.relay,
        rate,
        lspNodePubkey: () => lspNode,
        now,
        backupQuietMs: p.backupQuietMs ?? BACKUP_QUIET_MS,
        ...(p.registry.retryMs !== undefined && { retryMs: p.registry.retryMs }),
        ...(p.registry.checkpointQuietMs !== undefined && {
          checkpointQuietMs: p.registry.checkpointQuietMs,
        }),
        ...(p.registry.checkpointEveryMs !== undefined && {
          checkpointEveryMs: p.registry.checkpointEveryMs,
        }),
      }),
    );
  }
  const lsp = new LspAgent({ wallet: p.wallets.dave, targetCents: params.liquidityCents, now });
  const all = new Map<ActorId, { tick(): Promise<void> }>([...travelers, ['dave', lsp]]);
  const timer = tickEverySecond(all, p.log, p.tickMs);
  return {
    agents: new Map(),
    registry: 'v2',
    v2: {
      travelers,
      lsp,
      ...(p.registry.transportFor === undefined && { transport: shared }),
      params,
    },
    stop: () => {
      clearInterval(timer);
      for (const t of travelers.values()) t.registry.close();
    },
  };
}

/** The trip of SPEC §6.1-6.2 does not match this seed: retrying cannot fix it. */
export class StaleRelayError extends Error {}

/**
 * Sets up the trip of SPEC §6.1-6.2 on the relay: TRIP_CREATED, RATE_SET, then for each traveler
 * MEMBER_JOINED, MEMBER_ADMITTED and CHANNELS_READY. Every step is skipped if already on the
 * relay, so a restart (or a crash halfway) resumes where it stopped. With the real wallet the
 * asset and channels come from the seed (B2); with KITTY_FAKES=1 from the fake network.
 * `params` go into TRIP_CREATED and stay fixed for the whole trip (index.ts: timers from the
 * config, 45/120 s for the live demo; tests and check-real: DEMO_TRIP_PARAMS, 20/30 s).
 * Retries until the relay answers; throws StaleRelayError if the relay holds another seed's trip,
 * or a trip with other timers.
 */
export async function seedTrip(
  rt: AgentRuntime,
  seed: { assetId: string; channels: TripChannels; rate: EventBody<'RATE_SET'> },
  params: TripParams,
  log: Log,
): Promise<void> {
  const dave = rt.dave;
  if (dave === undefined) throw new Error('seedTrip is the v1 setup: with v2 use seedRegistry');
  for (;;) {
    try {
      await dave.sync();
      let trip = dave.trip();
      if (trip !== null && trip.assetId !== seed.assetId)
        throw new StaleRelayError(
          `the relay holds the trip of a previous seed (asset ${trip.assetId}, this seed ${seed.assetId}): wipe the relay database (RELAY_DB) and restart`,
        );
      if (
        trip !== null &&
        (trip.params.silentAssentSeconds !== params.silentAssentSeconds ||
          trip.params.paymentDeadlineSeconds !== params.paymentDeadlineSeconds ||
          upheldDeadlineSeconds(trip.params) !== upheldDeadlineSeconds(params))
      )
        throw new StaleRelayError(
          `the relay holds a trip with other timers (silent assent ${trip.params.silentAssentSeconds} s, payment deadline ${trip.params.paymentDeadlineSeconds} s, after an upheld dispute ${upheldDeadlineSeconds(trip.params)} s; requested ${params.silentAssentSeconds} s, ${params.paymentDeadlineSeconds} s, ${upheldDeadlineSeconds(params)} s): run \`pnpm demo:reset\``,
        );
      if (trip === null)
        trip = await dave.createTrip({
          name: 'Vietnam 2026',
          assetId: seed.assetId,
          params,
        });
      if (trip.rate === null) await dave.setRate(seed.rate);
      for (const id of MEMBER_IDS) {
        await rt.agents.get(id)?.joinTrip();
        const member = await dave.admit(id);
        if (!member.channelsReady) await dave.channelsReady(id, seed.channels[id]);
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

/**
 * KITTY_REGISTRY=v2: the trip in the registry v2, with no coordinator (the LSP only routes
 * payments). The first traveler creates it; each other one joins with an invite of the
 * creator, whose package (trip secret and invite) the QR would carry: here handed over in the
 * process. After a restart each member first looks for its trip again from its seed alone.
 * Retries until every traveler is in (a node not up yet).
 */
export async function seedRegistry(
  rt: AgentRuntime,
  p: { tripId: string; name: string; assetId: string; relays?: readonly string[] },
  log: Log,
): Promise<void> {
  const v2 = rt.v2;
  if (v2 === undefined) throw new Error('seedRegistry needs KITTY_REGISTRY=v2');
  for (;;) {
    try {
      await seedRegistryV2(v2.travelers, p.tripId, p.name, p.assetId, v2.params, p.relays);
      log.info(`trip "${p.name}" ready in the registry v2 (asset ${p.assetId}), no coordinator`);
      return;
    } catch (err) {
      const e = apiErrorOf(err);
      log.warn(`registry v2 setup: ${e.code} ${e.message}; retrying in 2 s`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export async function seedRegistryV2(
  travelers: ReadonlyMap<MemberId, { registry: RegistryV2 }>,
  tripId: string,
  name: string,
  assetId: string,
  params: TripParams,
  /** The relays of the trip (TRIP_CREATED.relays); none before step 4: in-process. */
  relays: readonly string[] = ['ws://localhost/in-process'],
): Promise<void> {
  const [creatorId = 'alice', ...others] = MEMBER_IDS;
  const creator = travelers.get(creatorId)?.registry;
  if (creator === undefined) throw new Error('no registry v2 for the creator');
  if (!(await creator.recover(tripId))) {
    const v2Params: fmt.TripParams = {
      assetId,
      assetDecimals: 2,
      displayDecimals: 2,
      silentAssentSeconds: params.silentAssentSeconds,
      invoiceExpirySeconds: fmt.DEFAULT_INVOICE_EXPIRY_SECONDS,
      rateMaxAgeSeconds: 86_400,
      oracles: [],
    };
    await creator.createTrip({
      tripId,
      name,
      params: v2Params,
      relays: [...relays],
      policy: DEFAULT_POLICY,
    });
  }
  for (const id of others) {
    const member = travelers.get(id)?.registry;
    if (member === undefined) throw new Error(`no registry v2 for ${id}`);
    if (await member.recover(tripId)) continue;
    await member.join(await creator.invite(), DEFAULT_POLICY);
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
  return seedTrip(
    rt,
    { assetId, channels: fakeTripChannels(), rate: loadRates() },
    DEMO_TRIP_PARAMS,
    log,
  );
}
