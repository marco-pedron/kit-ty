import {
  ActorIdSchema,
  MEMBER_IDS,
  seedFromMnemonic,
  type ActorId,
  type MemberId,
} from '@kitty/shared';
import { nodeUrls, type Config } from '../config.js';
import { RlnWallet } from '../wallet/rln-wallet.js';
import { loadMemberMnemonic, loadMemberWalletOptions } from '../wallet/secrets.js';
import type { Wallet } from '../wallet/types.js';
import type { seedTrip } from './runtime.js';
import { loadRates, loadSeedState } from './seed-state.js';

export type TripSeed = Parameters<typeof seedTrip>[1];

export function walletsOf(make: (a: ActorId) => Wallet): Record<ActorId, Wallet> {
  const w = {} as Record<ActorId, Wallet>;
  for (const a of ActorIdSchema.options) w[a] = make(a);
  return w;
}

/**
 * The real nodes of the seed (B2): one RlnWallet per actor, each reading only its own member's
 * secrets (B3), and the trip to set up on the relay (seed state and rates fixture).
 */
export function realSetup(config: Config): { wallets: Record<ActorId, Wallet>; seed: TripSeed } {
  const urls = nodeUrls(config);
  const wallets = walletsOf((a) => new RlnWallet(loadMemberWalletOptions(a, { nodeUrl: urls[a] })));
  const state = loadSeedState();
  return { wallets, seed: { assetId: state.assetId, channels: state.channels, rate: loadRates() } };
}

/**
 * KITTY_REGISTRY=v2: each traveler's BIP-39 seed, from the node mnemonic written by the seed
 * (B2): the registry keys derive from the same seed as the node (NIP-06, plan §4.1), offline.
 * Each agent receives only its own. The mnemonic is read by the wallet's own loader
 * (loadMemberMnemonic), so the secrets format stays in one place.
 */
export function realRegistrySeeds(file?: string): Record<MemberId, Uint8Array> {
  const seeds = {} as Record<MemberId, Uint8Array>;
  for (const id of MEMBER_IDS) seeds[id] = seedFromMnemonic(loadMemberMnemonic(id, file));
  return seeds;
}

/** KITTY_FAKES=1 with KITTY_REGISTRY=v2: random seeds, a new registry at every start. */
export function fakeRegistrySeeds(): Record<MemberId, Uint8Array> {
  const seeds = {} as Record<MemberId, Uint8Array>;
  for (const id of MEMBER_IDS) seeds[id] = crypto.getRandomValues(new Uint8Array(64));
  return seeds;
}
