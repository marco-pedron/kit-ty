import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActorId } from '@kitty/shared';
import { deriveAppSecretHex, type RlnWalletOptions } from './rln-wallet.js';

// Reads the files written by the seed (B2) and returns the options of ONE member's wallet:
// their node URL, their app key and the trip asset. Nothing of the other members leaves here.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export const DEFAULT_SECRETS_FILE = `${repoRoot}infra/.secrets/nodes.json`;
export const DEFAULT_SEED_STATE_FILE = `${repoRoot}infra/.out/seed-state.json`;

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `cannot read ${what} at ${path} (run pnpm demo:reset first): ${(e as Error).message}`,
      { cause: e },
    );
  }
}

export function loadMemberWalletOptions(
  actor: ActorId,
  p: { nodeUrl: string; secretsFile?: string; seedStateFile?: string },
): RlnWalletOptions {
  const secrets = readJson(
    p.secretsFile ?? process.env.KITTY_SECRETS_FILE ?? DEFAULT_SECRETS_FILE,
    'node secrets',
  ) as {
    nodes?: Record<string, { mnemonic?: unknown }>;
  };
  const mnemonic = secrets.nodes?.[actor]?.mnemonic;
  if (typeof mnemonic !== 'string')
    throw new Error(`no node mnemonic for ${actor} in the secrets file`);
  const seed = readJson(p.seedStateFile ?? DEFAULT_SEED_STATE_FILE, 'seed state') as {
    assetId?: unknown;
  };
  if (typeof seed.assetId !== 'string') throw new Error('no assetId in the seed state');
  return { nodeUrl: p.nodeUrl, appSecretHex: deriveAppSecretHex(mnemonic), assetId: seed.assetId };
}
