import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEMBER_IDS, RateSetBodySchema, type EventBody, type MemberId } from '@kitty/shared';
import { z } from 'zod';

// What the agent needs to set up the trip on the relay after the seed (B2): the asset, the two
// channels of each traveler (from the non-secret infra/.out/seed-state.json) and the rate of the
// day (infra/fixtures/rates.json). No secrets are read here.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const DEFAULT_SEED_STATE_FILE =
  process.env.KITTY_SEED_STATE_FILE ?? `${repoRoot}infra/.out/seed-state.json`;
export const DEFAULT_RATES_FILE = `${repoRoot}infra/fixtures/rates.json`;

const ChannelSchema = z.object({
  kind: z.enum(['travel', 'liquidity']),
  peer: z.string(),
  channelId: z.string().min(1),
});

const SeedStateSchema = z.object({
  assetId: z.string().min(1),
  members: z.record(z.string(), z.object({ channels: z.array(ChannelSchema) })),
});

export type TripChannels = Record<MemberId, { tripChannelId: string; liquidityChannelId: string }>;

export interface SeedState {
  assetId: string;
  channels: TripChannels;
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${what} at ${path}: ${(e as Error).message}`, { cause: e });
  }
}

/** The travel and liquidity channel of each traveler with dave, as seen by the traveler's node. */
export function parseSeedState(raw: unknown): SeedState {
  const s = SeedStateSchema.parse(raw);
  const channels = {} as TripChannels;
  for (const id of MEMBER_IDS) {
    const own = s.members[id]?.channels.filter((c) => c.peer === 'dave') ?? [];
    const travel = own.find((c) => c.kind === 'travel');
    const liquidity = own.find((c) => c.kind === 'liquidity');
    if (travel === undefined || liquidity === undefined)
      throw new Error(`seed state: ${id} has no travel and liquidity channel with dave`);
    channels[id] = { tripChannelId: travel.channelId, liquidityChannelId: liquidity.channelId };
  }
  return { assetId: s.assetId, channels };
}

export function loadSeedState(file = DEFAULT_SEED_STATE_FILE): SeedState {
  return parseSeedState(readJson(file, 'seed state (run pnpm demo:reset first)'));
}

/** The RATE_SET body from the rates fixture; `base` must be USD (rates are units per 1 USD). */
export function loadRates(file = DEFAULT_RATES_FILE): EventBody<'RATE_SET'> {
  const raw = z
    .object({ base: z.literal('USD') })
    .loose()
    .parse(readJson(file, 'rates fixture'));
  return RateSetBodySchema.parse(raw);
}
