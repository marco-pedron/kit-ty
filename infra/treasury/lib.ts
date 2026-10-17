// Shared helpers for the regtest seed: RLN REST calls, mining, secrets. Regtest only.
// Request bodies are the ones verified in docs/spike-lightning.md; amounts are integer
// DUSD minimal units (1 = 0.01 DUSD) and are plain JSON numbers only at the REST boundary.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INFRA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SECRETS_FILE =
  process.env.KITTY_SECRETS_FILE || join(INFRA_DIR, '.secrets', 'nodes.json');
export const OUT_DIR = join(INFRA_DIR, '.out');
export const TREASURY_DATA_DIR =
  process.env.TREASURY_DATA_DIR || join(INFRA_DIR, 'data', 'treasury');

export const MEMBERS = ['alice', 'bob', 'charlie', 'dave'] as const;
export type Member = (typeof MEMBERS)[number];
export const TRAVELLERS = ['alice', 'bob', 'charlie'] as const;

const API_PORT: Record<Member, number> = { alice: 3001, bob: 3002, charlie: 3003, dave: 3004 };
export const PEER_PORT: Record<Member, number> = {
  alice: 9735,
  bob: 9736,
  charlie: 9737,
  dave: 9738,
};

export function nodeUrl(m: Member): string {
  return process.env[`RLN_${m.toUpperCase()}_URL`] || `http://127.0.0.1:${API_PORT[m]}`;
}

// Addresses as seen from inside the compose network (RLN containers).
export const PROXY_INTERNAL = process.env.RGB_PROXY_URL_INTERNAL || 'rpc://proxy:3000/json-rpc';
// The same proxy as seen from the host, where the treasury runs.
export const PROXY_HOST = process.env.RGB_PROXY_URL_HOST || 'rpc://127.0.0.1:3000/json-rpc';
export const INDEXER_HOST = process.env.ELECTRS_URL_HOST || 'tcp://127.0.0.1:50001';

export function unlockBody(m: Member, password: string) {
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
    announce_alias: m,
  };
}

/** RLN error body is { error, code, name }; the message never includes request bodies (passwords). */
export class RlnError extends Error {
  readonly status: number;
  readonly rlnName: string;
  constructor(member: Member, path: string, status: number, rlnName: string, detail: string) {
    super(`${member} ${path} → HTTP ${status} ${rlnName}: ${detail}`);
    this.status = status;
    this.rlnName = rlnName;
  }
}

export async function rln<T = Record<string, unknown>>(
  m: Member,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(nodeUrl(m) + path, init);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new RlnError(m, path, res.status, json.name ?? '?', json.error ?? text);
  return json as T;
}

// --- bitcoind (miner wallet) through docker compose -------------------------------------

function bcli(...args: string[]): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      join(INFRA_DIR, 'docker-compose.yml'),
      'exec',
      '-T',
      '-u',
      'blits',
      'bitcoind',
      'bitcoin-cli',
      '-regtest',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}

export function mine(blocks: number): number {
  bcli('-rpcwallet=miner', '-generate', String(blocks));
  return Number(bcli('getblockcount'));
}

export function fund(address: string, btc: string): string {
  return bcli('-rpcwallet=miner', 'sendtoaddress', address, btc);
}

// --- esplora (same chain view the proofs link to) -----------------------------------------

export const ESPLORA_URL = process.env.ESPLORA_URL || 'http://127.0.0.1:3010';

/** True when esplora knows the tx (mempool or confirmed). */
export async function esploraHasTx(txid: string): Promise<boolean> {
  return (await fetch(`${ESPLORA_URL}/tx/${txid}/status`)).ok;
}

/** Mines `blocks` and waits until esplora has indexed the new tip. */
export async function mineAndSync(blocks: number): Promise<number> {
  const height = mine(blocks);
  await waitFor(
    `esplora at height ${height}`,
    async () => {
      const tip = Number(await (await fetch(`${ESPLORA_URL}/blocks/tip/height`)).text());
      return tip >= height;
    },
    { timeoutMs: 30_000, everyMs: 500 },
  );
  return height;
}

// --- polling ------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls `check` every `everyMs` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 120_000, everyMs = 1000 } = {},
): Promise<T> {
  const start = Date.now();
  let lastErr = '';
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timeout after ${timeoutMs} ms waiting for ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`,
      );
    await sleep(everyMs);
  }
}

// --- secrets (gitignored, mode 0600, never printed) ----------------------------------------

export interface Secrets {
  nodes: Partial<Record<Member, { password: string; mnemonic?: string }>>;
  /** Dave's treasury (wdk-wallet-rgb): its own BIP-39 mnemonic, never an RLN node's. */
  treasuryMnemonic?: string;
}

export function loadSecrets(): Secrets {
  return existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : { nodes: {} };
}

export function saveSecrets(s: Secrets): void {
  mkdirSync(dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  chmodSync(SECRETS_FILE, 0o600);
}

export function writeOut(name: string, data: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export function log(step: string, data?: unknown): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${step}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
}
