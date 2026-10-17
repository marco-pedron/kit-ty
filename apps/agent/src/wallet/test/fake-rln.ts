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
