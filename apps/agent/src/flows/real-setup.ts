import { ActorIdSchema, type ActorId } from '@kitty/shared';
import { nodeUrls, type Config } from '../config.js';
import { RlnWallet } from '../wallet/rln-wallet.js';
import { loadMemberWalletOptions } from '../wallet/secrets.js';
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
