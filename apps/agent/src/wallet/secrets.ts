import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActorId } from '@kitty/shared';
import { createEsplora, dockerMiner } from './chain.js';
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

/**
 * KITTY_REGISTRY=v2 (stream A, step 3): the node mnemonic of ONE member, from which the agent
 * derives that member's registry keys (NIP-06). Nothing of the other members leaves here.
 */
export function loadMemberMnemonic(actor: ActorId, secretsFile?: string): string {
  const secrets = readJson(
    secretsFile ?? process.env.KITTY_SECRETS_FILE ?? DEFAULT_SECRETS_FILE,
    'node secrets',
  ) as { nodes?: Record<string, { mnemonic?: unknown }> };
  const mnemonic = secrets.nodes?.[actor]?.mnemonic;
  if (typeof mnemonic !== 'string')
    throw new Error(`no node mnemonic for ${actor} in the secrets file`);
  return mnemonic;
}

export function loadMemberWalletOptions(
  actor: ActorId,
  p: {
    nodeUrl: string;
    secretsFile?: string;
    seedStateFile?: string;
    esploraUrl?: string;
    backupDir?: string;
  },
): RlnWalletOptions {
  const secrets = readJson(
    p.secretsFile ?? process.env.KITTY_SECRETS_FILE ?? DEFAULT_SECRETS_FILE,
    'node secrets',
  ) as {
    nodes?: Record<string, { mnemonic?: unknown; password?: unknown }>;
  };
  const mnemonic = secrets.nodes?.[actor]?.mnemonic;
  if (typeof mnemonic !== 'string')
    throw new Error(`no node mnemonic for ${actor} in the secrets file`);
  const seed = readJson(p.seedStateFile ?? DEFAULT_SEED_STATE_FILE, 'seed state') as {
    assetId?: unknown;
  };
  if (typeof seed.assetId !== 'string') throw new Error('no assetId in the seed state');
  const opts: RlnWalletOptions = {
    nodeUrl: p.nodeUrl,
    appSecretHex: deriveAppSecretHex(mnemonic),
    assetId: seed.assetId,
  };
  // B6, SPEC §12: the node's own password backs it up and unlocks it again afterwards.
  const password = secrets.nodes?.[actor]?.password;
  if (typeof password === 'string')
    opts.backup = {
      password,
      unlockBody: unlockBody(actor, password),
      hostDir: p.backupDir ?? `${repoRoot}infra/data/backups/${actor}`,
    };
  // Opening and closing channels on regtest: dave opens liquidity (and with v1 closes an
  // excluded member's channels); with v2 each member closes its own when it leaves (23/10).
  const esploraUrl = p.esploraUrl ?? process.env.ESPLORA_URL ?? 'http://127.0.0.1:3010';
  opts.chain = { esplora: createEsplora(esploraUrl), miner: dockerMiner };
  return opts;
}

/**
 * The /unlock body of a node, the same as the seed's (infra/treasury/lib.ts unlockBody): the
 * regtest bitcoind and electrs as the containers see them. No secret but the password.
 */
export function unlockBody(actor: ActorId, password: string): Record<string, unknown> {
  return {
    password,
    ldk_chain_sync: {
      mode: 'BlockSync',
      config: {
        bitcoind_rpc_username: process.env.BITCOIND_RPC_USER || 'user',
        bitcoind_rpc_password: process.env.BITCOIND_RPC_PASSWORD || 'password',
        bitcoind_rpc_host: process.env.BITCOIND_RPC_HOST || 'bitcoind',
        bitcoind_rpc_port: 18443,
      },
    },
    indexer_url: process.env.ELECTRS_URL_INTERNAL || 'electrs:50001',
    announce_addresses: [],
    announce_alias: actor,
  };
}
