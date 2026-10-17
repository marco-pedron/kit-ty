import { createHash } from 'node:crypto';

// A scripted rgb-lightning-node for unit tests: each endpoint answers from a handler, and
// every request is recorded. Bodies mirror the ones in docs/spike-lightning.md.

export type Reply = { status?: number; json?: unknown; text?: string } | 'network-error';
export type Handler = (body: Record<string, unknown>) => Reply;

export const ASSET = 'rgb:16sDAWsj-ep2RC7o-g5r2e81-LslCiVR-bK_ZRhg-ohfPz7w';
export const ALICE_NODE = '03dbe52444680cc2d9acdd1df7bb45941f4e41c665ce745bb39b2caecbf9f643f7';
export const PREIMAGE = 'c9c42055'.padEnd(64, '1');
export const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

export function decoded(over: Record<string, unknown> = {}) {
  return {
    amt_msat: 3_000_000,
    expiry_sec: 3600,
    timestamp: Math.floor(Date.now() / 1000),
    asset_id: ASSET,
    asset_amount: 309,
    description: 'kitty:test:1:alice',
    payment_hash: PAYMENT_HASH,
    payment_secret: 'ab'.repeat(32),
    payee_pubkey: ALICE_NODE,
    network: 'Regtest',
    ...over,
  };
}

export function payment(
  status: 'Pending' | 'Succeeded' | 'Failed',
  over: Record<string, unknown> = {},
) {
  return {
    payment: {
      amt_msat: 3_000_000,
      asset_amount: 309,
      asset_id: ASSET,
      payment_hash: PAYMENT_HASH,
      inbound: false,
      status,
      created_at: 1,
      updated_at: 2,
      payee_pubkey: ALICE_NODE,
      ...(status === 'Succeeded' ? { preimage: PREIMAGE } : {}),
      ...over,
    },
  };
}

export class FakeRln {
  readonly calls: { endpoint: string; body: Record<string, unknown> }[] = [];
  readonly handlers: Record<string, Handler> = {
    '/nodeinfo': () => ({ json: { pubkey: ALICE_NODE, rgb_htlc_min_msat: 3_000_000 } }),
    '/lninvoice': () => ({ json: { invoice: 'lnbcrt30u1fake' } }),
    '/decodelninvoice': () => ({ json: decoded() }),
    '/assetbalance': () => ({
      json: {
        settled: 5000,
        future: 5000,
        spendable: 5000,
        offchain_outbound: 5000,
        offchain_inbound: 3000,
      },
    }),
    '/sendpayment': () => ({
      json: { payment_id: PAYMENT_HASH, payment_hash: PAYMENT_HASH, status: 'Pending' },
    }),
    '/getpayment': () => ({ json: payment('Succeeded') }),
  };

  on(endpoint: string, h: Handler): this {
    this.handlers[endpoint] = h;
    return this;
  }

  count(endpoint: string): number {
    return this.calls.filter((c) => c.endpoint === endpoint).length;
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const endpoint = new URL(req.url).pathname;
    const raw = req.method === 'GET' ? '' : await req.text();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.calls.push({ endpoint, body });
    const h = this.handlers[endpoint];
    if (!h) throw new Error(`fake RLN: no handler for ${endpoint}`);
    const r = h(body);
    if (r === 'network-error') throw new TypeError('fetch failed');
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200 });
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

export const rlnError = (status: number, name: string, error = name): Reply => ({
  status,
  json: { error, code: status, name },
});

// --- B7: dave's channels with charlie, and the chain they close on ----------------------

export const CHARLIE_NODE = '020150342089c80a83507b7c1cf3e5ee27e1f08a3dfc7d119e121c79829f51273d';
export const DAVE_NODE = '02ee056673eb9280f4dba7831f3b22cd1b01240cc0f51369c1b6e1c7ac969519a7';
export const TRIP_FUNDING = 'f1'.repeat(32);
export const LIQ_FUNDING = 'f2'.repeat(32);

export function channel(
  channelId: string,
  fundingTxid: string,
  over: Record<string, unknown> = {},
) {
  return {
    channel_id: channelId,
    funding_txid: fundingTxid,
    peer_pubkey: CHARLIE_NODE,
    status: 'Opened',
    ready: true,
    capacity_sat: 1_000_000,
    is_usable: true,
    public: true,
    ...over,
  };
}

type Tx = {
  txid: string;
  vout: { value: number; scriptpubkey_type: string }[];
  status: { confirmed: boolean };
};

/**
 * A regtest chain for unit tests: funding txs exist; /closechannel puts a closing tx in the
 * mempool (unless told not to); each mined block confirms the mempool, and the sweep of a
 * closing tx's outputs is broadcast `sweepAfter` blocks after it confirms.
 */
export class FakeChain {
  readonly txs = new Map<string, Tx>();
  readonly spends = new Map<string, { txid: string; confirmedAt: number | null }>();
  mempool: string[] = [];
  height = 124;
  mined = 0;
  /** Spike Q7: close confirmed at h164, sweep confirmed at h170 (broadcast at h169). */
  sweepAfter = 5;
  /** The nodes broadcast a sweep this long after it becomes possible (they sync late). */
  broadcastDelayMs = 0;
  private confirmedAt = new Map<string, number>();
  private closes = 0;

  constructor() {
    for (const f of [TRIP_FUNDING, LIQ_FUNDING])
      this.addTx(
        f,
        [
          { value: 0, scriptpubkey_type: 'op_return' },
          { value: 1_000_000, scriptpubkey_type: 'v0_p2wsh' },
          { value: 130_213, scriptpubkey_type: 'v1_p2tr' },
        ],
        true,
      );
  }

  addTx(txid: string, vout: Tx['vout'], confirmed = false): void {
    this.txs.set(txid, { txid, vout, status: { confirmed } });
    if (confirmed) this.confirmedAt.set(txid, this.height);
  }

  /** Called by /closechannel: spends output 1 of the funding tx. Returns the closing txid. */
  close(fundingTxid: string): string {
    this.closes += 1;
    const txid = `c${this.closes}`.padEnd(64, '0');
    this.addTx(txid, [
      { value: 0, scriptpubkey_type: 'op_return' },
      { value: 990_000, scriptpubkey_type: 'v0_p2wpkh' },
      { value: 8_000, scriptpubkey_type: 'v0_p2wpkh' },
    ]);
    this.spends.set(`${fundingTxid}:1`, { txid, confirmedAt: null });
    this.mempool.push(txid);
    return txid;
  }

  readonly miner = {
    mine: async (blocks: number): Promise<number> => {
      for (let b = 0; b < blocks; b++) {
        this.height += 1;
        this.mined += 1;
        for (const t of this.mempool) {
          const tx = this.txs.get(t);
          if (tx) tx.status.confirmed = true;
          this.confirmedAt.set(t, this.height);
          for (const s of this.spends.values()) if (s.txid === t) s.confirmedAt = this.height;
        }
        this.mempool = [];
        // nodes sweep the outputs of closes confirmed long enough ago
        for (const [t, at] of this.confirmedAt)
          if (t.startsWith('c') && this.height - at >= this.sweepAfter) {
            const sweep = `5${t.slice(1, 3)}`.padEnd(64, '5');
            if (this.txs.has(sweep)) continue;
            this.addTx(sweep, [{ value: 990_000, scriptpubkey_type: 'v0_p2wpkh' }]);
            this.mempool.push(sweep);
            for (const i of [1, 2])
              this.spends.set(`${t}:${i}`, { txid: sweep, confirmedAt: null });
          }
      }
      return this.height;
    },
  };

  readonly esplora = {
    baseUrl: 'http://127.0.0.1:3010',
    tx: async (txid: string) => this.txs.get(txid) ?? null,
    outspends: async (txid: string) => {
      const tx = this.txs.get(txid);
      if (!tx) throw new Error(`unknown tx ${txid}`);
      return tx.vout.map((_, i) => {
        const s = this.spends.get(`${txid}:${i}`);
        return s
          ? { spent: true, txid: s.txid, status: { confirmed: s.confirmedAt !== null } }
          : { spent: false };
      });
    },
    tipHeight: async () => this.height,
  };
}
