// Helpers for the kitty-kaleido stack: typed REST calls to the fork's RLN nodes, regtest chain
// ops over bitcoind RPC, node setup. Every request body follows vendor/rln-kaleido-openapi.yaml
// (kaleidoswap/rgb-lightning-node@1e4b1c3) through the generated src/client/schema.d.ts.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createClient from 'openapi-fetch';
import type { components, paths } from './client/schema.js';

export type S = components['schemas'];
export type Member = 'alice' | 'bob' | 'charlie' | 'dave';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = join(ROOT, '.secrets');
const API_PORT: Record<Member, number> = { alice: 23001, bob: 23002, charlie: 23003, dave: 23004 };
const PEER_PORT: Record<Member, number> = { alice: 9735, bob: 9736, charlie: 9737, dave: 9738 };
const BITCOIND = process.env.KK_BITCOIND_URL ?? 'http://127.0.0.1:28443';
const ELECTRS = { host: '127.0.0.1', port: Number(process.env.KK_ELECTRS_PORT ?? 23501) };
export const PROXY_ENDPOINT = 'rpc://proxy:3000/json-rpc';

export function nodeUrl(m: Member): string {
  return process.env[`KK_${m.toUpperCase()}_URL`] ?? `http://127.0.0.1:${API_PORT[m]}`;
}
export const peerAddr = (m: Member) => `rln-${m}:${PEER_PORT[m]}`;

export class RlnError extends Error {
  readonly member: Member;
  readonly path: string;
  readonly status: number;
  readonly rlnName: string | undefined;
  constructor(member: Member, path: string, status: number, rlnName: string | undefined, message: string) {
    super(`${member} ${path} → ${status} ${rlnName ?? ''}: ${message}`);
    this.member = member;
    this.path = path;
    this.status = status;
    this.rlnName = rlnName;
  }
}

const clients = new Map<Member, ReturnType<typeof createClient<paths>>>();
export function client(m: Member) {
  let c = clients.get(m);
  if (!c) clients.set(m, (c = createClient<paths>({ baseUrl: nodeUrl(m) })));
  return c;
}

type PostPath = { [P in keyof paths]: paths[P] extends { post: unknown } ? P : never }[keyof paths];
type GetPath = { [P in keyof paths]: paths[P] extends { get: unknown } ? P : never }[keyof paths];
type ReqBody<Op> = Op extends { requestBody?: infer R } ? NonNullable<R> : never;
type Body<P extends PostPath> = [ReqBody<paths[P]['post']>] extends [never] ? never : ReqBody<paths[P]['post']> extends { content: { 'application/json': infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;

/** POST with the body type of the fork's openapi.yaml; throws RlnError on a non-2xx. */
export async function post<P extends PostPath>(m: Member, path: P, ...body: [Body<P>] extends [never] ? [] : [Body<P>]): Promise<Ok<paths[P]['post']>> {
  const res = await fetch(nodeUrl(m) + path, {
    method: 'POST',
    ...(body.length ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body[0]) } : {}),
  });
  return parse(m, path, res);
}
export async function get<P extends GetPath>(m: Member, path: P): Promise<Ok<paths[P]['get']>> {
  return parse(m, path, await fetch(nodeUrl(m) + path));
}
async function parse(m: Member, path: string, res: Response) {
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new RlnError(m, path, res.status, json.name, json.error ?? text);
  return json;
}

// ---------- chain (regtest) ----------

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const res = await fetch(BITCOIND + (wallet ? `/wallet/${wallet}` : '/'), {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'kk', method, params }),
  });
  const json = (await res.json()) as { result: T; error: { message: string } | null };
  if (json.error) throw new Error(`bitcoind ${method}: ${json.error.message}`);
  return json.result;
}
export const height = () => rpc<number>('getblockcount');
let minerAddr: string | undefined;
export async function ensureMiner(): Promise<void> {
  const wallets = await rpc<string[]>('listwallets');
  if (!wallets.includes('miner')) {
    try {
      await rpc('loadwallet', ['miner']);
    } catch {
      await rpc('createwallet', ['miner']);
    }
  }
  minerAddr = await rpc<string>('getnewaddress', [], 'miner');
  const h = await height();
  if (h < 103) await rpc('generatetoaddress', [103 - h, minerAddr]);
  await waitElectrs();
}
/** Mines n blocks and waits until electrs (the nodes' indexer) has them. */
export async function mine(n: number): Promise<number> {
  if (!minerAddr) await ensureMiner();
  await rpc('generatetoaddress', [n, minerAddr]);
  return waitElectrs();
}
export const sendBtc = (addr: string, btc: number) => rpc<string>('sendtoaddress', [addr, btc], 'miner');
export const rawTx = (txid: string) => rpc<{ vin: unknown[]; vout: unknown[]; confirmations?: number }>('getrawtransaction', [txid, true]);
export const mempool = () => rpc<string[]>('getrawmempool');

function electrsHeight(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = connect(ELECTRS, () => s.write('{"id":1,"method":"blockchain.headers.subscribe","params":[]}\n'));
    let buf = '';
    s.setTimeout(5000, () => (s.destroy(), reject(new Error('electrs timeout'))));
    s.on('data', (d) => {
      buf += d;
      const reply = buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.id === 1);
      if (reply) {
        s.end();
        resolve(reply.result.height);
      }
    });
    s.on('error', reject);
  });
}
async function waitElectrs(): Promise<number> {
  const target = await height();
  await waitFor('electrs sync', async () => (await electrsHeight()) >= target, 60_000);
  return target;
}

// ---------- utils ----------

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(what: string, ok: () => Promise<boolean>, timeoutMs = 60_000, everyMs = 250): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await ok()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    await sleep(everyMs);
  }
}
export const t0 = Date.now();
export function log(step: string, data: Record<string, unknown> = {}): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${step}`, Object.keys(data).length ? JSON.stringify(data) : '');
}
export function preimageAndHash(): { preimage: string; hash: string } {
  const p = randomBytes(32);
  return { preimage: p.toString('hex'), hash: createHash('sha256').update(p).digest('hex') };
}
export const sha256hex = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

// ---------- node setup ----------

/** /init (password saved in .secrets/, gitignored) or reuse the saved one, then /unlock. */
export async function setupNode(m: Member): Promise<string> {
  mkdirSync(SECRETS, { recursive: true });
  const file = join(SECRETS, `${m}.json`);
  let password: string;
  if (existsSync(file)) password = JSON.parse(readFileSync(file, 'utf8')).password;
  else {
    password = randomBytes(24).toString('hex');
    const { mnemonic } = await post(m, '/init', { password });
    writeFileSync(file, JSON.stringify({ password, mnemonic }), { mode: 0o600 });
  }
  try {
    await post(m, '/unlock', {
      password,
      ldk_chain_sync: {
        mode: 'BlockSync',
        config: {
          bitcoind_rpc_username: 'user',
          bitcoind_rpc_password: 'password',
          bitcoind_rpc_host: 'bitcoind',
          bitcoind_rpc_port: 18443,
        },
      },
      indexer_url: 'electrs:50001',
      announce_addresses: [],
      announce_alias: m,
    } as Body<'/unlock'>);
  } catch (e) {
    if (!(e instanceof RlnError && e.rlnName === 'AlreadyUnlocked')) throw e;
  }
  return (await get(m, '/nodeinfo')).pubkey;
}

/** BTC to the node, then colorable UTXOs. */
export async function fundNode(m: Member, btc: number, utxos: number, size: number): Promise<void> {
  const { address } = await post(m, '/address');
  await sendBtc(address, btc);
  await mine(1);
  await post(m, '/createutxos', { up_to: true, num: utxos, size, fee_rate: 5, skip_sync: false });
  await mine(1);
}

export async function channels(m: Member): Promise<S['Channel'][]> {
  return (await get(m, '/listchannels')).channels;
}
export async function assetBalance(m: Member, assetId: string): Promise<S['AssetBalanceResponse']> {
  return post(m, '/assetbalance', { asset_id: assetId });
}
export async function refresh(m: Member): Promise<void> {
  await post(m, '/refreshtransfers', { filter: [], skip_sync: false });
}
