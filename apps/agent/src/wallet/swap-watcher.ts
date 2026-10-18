import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Miner } from './chain.js';

// EXPERIMENT ln-1ch-swap (branch experiment/rgb-lightning-node): dave's watcher of the atomic
// swaps of the onboarding (experiments/kaleidoswap/RESULTS.md §1, step 8). For every swap dave
// paid, it reads the preimage P from his node (/getpayment, payment_type Outbound) and claims
// the on-chain HTLC with it before T, through htlc-tool (the kaleidoswap rgb-lib fork). The
// state is on disk (the same records the seed writes), so a restart resumes (RESULTS.md case 9).
// Critical like a watchtower: if it is down until T, dave loses D (case 11).

const execFileP = promisify(execFile);

/** dave's record, as experiments/kaleidoswap/src/swap.ts DaveSwap writes it. */
interface DaveSwap {
  id: string;
  traveler: string;
  amount: number;
  claimSecret: string;
  claimKey: string;
  refundKey: string;
  timeout: number;
  hash?: string;
  outpoint?: string;
  state: 'offered' | 'refused' | 'paid' | 'ln_failed' | 'claimed_onchain';
  preimage?: string;
  claimTxid?: string;
  claimHeight?: number;
}

export interface SwapWatcherOptions {
  /** experiments' run dir (KK_RUN_DIR): swaps/<who>/*.json and wallets/. */
  runDir: string;
  daveNodeUrl: string;
  bitcoindUrl: string;
  dockerNetwork: string;
  assetId: string;
  miner: Miner;
  htlcImage?: string;
  log: { info: (m: string) => void; error: (m: string) => void };
}

export interface SwapWatcherStatus {
  running: boolean;
  lastTickAt: string | null;
  swaps: { id: string; state: string; timeout: number; claimTxid: string | null }[];
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'watcher', method, params }),
  });
  const j = (await res.json()) as { result: T; error: { message: string } | null };
  if (j.error) throw new Error(`bitcoind ${method}: ${j.error.message}`);
  return j.result;
}

export class SwapWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastTickAt: string | null = null;

  constructor(private readonly o: SwapWatcherOptions) {}

  private dir(who: string): string {
    return join(this.o.runDir, 'swaps', who);
  }

  private records(): DaveSwap[] {
    const dir = this.dir('dave');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as DaveSwap);
  }

  private save(d: DaveSwap): void {
    writeFileSync(join(this.dir('dave'), `${d.id}.json`), JSON.stringify(d, null, 2), {
      mode: 0o600,
    });
  }

  /** One htlc-tool command (docker, on the stack's network); returns its last JSON line. */
  private async tool(cmd: string, args: Record<string, string | number>): Promise<any> {
    const argv = Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)]);
    const wallets = join(this.o.runDir, 'wallets');
    const image = this.o.htlcImage ?? 'kitty/htlc-tool:dev';
    const r = await execFileP('docker', [
      'run',
      '--rm',
      '--network',
      this.o.dockerNetwork,
      '-v',
      `${wallets}:/wallets`,
      image,
      cmd,
      ...argv,
    ]).catch((e: { stdout?: string; message: string }) => {
      const last = (e.stdout ?? '').trim().split('\n').pop();
      throw new Error(`htlc-tool ${cmd}: ${last || e.message}`);
    });
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  }

  private async outboundPayment(
    hash: string,
  ): Promise<{ status: string; preimage?: string | null } | null> {
    const res = await fetch(`${this.o.daveNodeUrl}/getpayment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payment_hash: hash, payment_type: 'Outbound' }),
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`dave /getpayment: HTTP ${res.status}`);
    return ((await res.json()) as { payment: { status: string; preimage?: string | null } })
      .payment;
  }

  /** One pass over dave's swaps in state `paid`. Returns what it did. */
  async tick(): Promise<string[]> {
    const did: string[] = [];
    const height = await rpc<number>(this.o.bitcoindUrl, 'getblockcount', []);
    for (const d of this.records().filter((x) => x.state === 'paid')) {
      if (!d.hash || !d.outpoint) continue;
      if (height >= d.timeout - 10)
        this.o.log.error(
          `swap ${d.id}: height ${height} close to T ${d.timeout} and not claimed: dave may lose ${d.amount}`,
        );
      const p = await this.outboundPayment(d.hash);
      if (p?.status === 'Failed') {
        d.state = 'ln_failed';
        this.save(d);
        did.push(`${d.id}: LN payment failed back, nothing to claim`);
        continue;
      }
      if (p?.status !== 'Succeeded' || !p.preimage) continue;
      if (createHash('sha256').update(Buffer.from(p.preimage, 'hex')).digest('hex') !== d.hash)
        throw new Error(`swap ${d.id}: the node returned a preimage of another hash`);
      d.preimage = p.preimage;
      const spend = await this.tool('spend', {
        wallet: 'dave-htlc',
        path: 'claim',
        hash: d.hash,
        claim: d.claimKey,
        refund: d.refundKey,
        timeout: d.timeout,
        secret: d.claimSecret,
        preimage: p.preimage,
        outpoint: d.outpoint,
        'asset-id': this.o.assetId,
        amount: d.amount,
      });
      try {
        await rpc<string>(this.o.bitcoindUrl, 'sendrawtransaction', [spend.tx_hex]);
      } catch (e) {
        await this.tool('abort', { wallet: 'dave-htlc', op: spend.operation_id });
        did.push(`${d.id}: claim rejected: ${(e as Error).message}`);
        continue;
      }
      d.claimHeight = await this.o.miner.mine(1);
      await this.tool('apply', {
        wallet: 'dave-htlc',
        op: spend.operation_id,
        'asset-id': this.o.assetId,
      });
      d.state = 'claimed_onchain';
      d.claimTxid = spend.txid;
      this.save(d);
      did.push(`${d.id}: claimed on-chain ${spend.txid} at ${d.claimHeight} (T ${d.timeout})`);
    }
    this.lastTickAt = new Date().toISOString();
    return did;
  }

  start(everyMs = 5_000): void {
    if (this.timer) return;
    const run = () => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .then((did) => did.forEach((m) => this.o.log.info(`swap watcher: ${m}`)))
        .catch((e: unknown) => this.o.log.error(`swap watcher: ${String(e)}`))
        .finally(() => (this.busy = false));
    };
    run();
    this.timer = setInterval(run, everyMs);
    this.o.log.info(`swap watcher of dave started (${this.records().length} swaps on disk)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SwapWatcherStatus {
    return {
      running: this.timer !== null,
      lastTickAt: this.lastTickAt,
      swaps: this.records().map((d) => ({
        id: d.id,
        state: d.state,
        timeout: d.timeout,
        claimTxid: d.claimTxid ?? null,
      })),
    };
  }
}

/** The traveler's side of the onboarding swap, from their own swap record (no secret leaves). */
export interface TravelerSwapInfo {
  lockTxid: string;
  preimage: string;
  paymentHash: string;
  cents: bigint;
}

export function travelerSwapInfo(runDir: string, member: string): TravelerSwapInfo | null {
  const file = join(runDir, 'swaps', member, `swap-${member}.json`);
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, 'utf8')) as {
    state: string;
    preimage: string;
    hash: string;
    amount: number;
    lock?: { txid: string };
  };
  if (s.state !== 'claimed_ln' || !s.lock) return null;
  // shown as a proof: only if the preimage really opens the hash
  if (createHash('sha256').update(Buffer.from(s.preimage, 'hex')).digest('hex') !== s.hash)
    return null;
  return { lockTxid: s.lock.txid, preimage: s.preimage, paymentHash: s.hash, cents: BigInt(s.amount) };
}
