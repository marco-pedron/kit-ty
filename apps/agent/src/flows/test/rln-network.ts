import { createHash, randomBytes } from 'node:crypto';
import type { ActorId, DecodedInvoice } from '@kitty/shared';

// TESTS ONLY: four rgb-lightning-node REST APIs on one simulated regtest network, so the agents
// run on the REAL RlnWallet (B3) without Docker. Only the endpoints RlnWallet calls are served,
// with the bodies of docs/spike-lightning.md. Invoices are opaque strings (no BOLT11 encoding):
// every node decodes them from the shared table, as /decodelninvoice would. Payments route
// payer → dave → payee in one step; the balances are the DUSD of the trip and liquidity channels.

const ACTORS: readonly ActorId[] = ['alice', 'bob', 'charlie', 'dave'];
const HTLC_MIN_MSAT = 3_000_000;

interface Invoice {
  payee: ActorId;
  paymentHash: string;
  preimage: string;
  cents: number;
  description: string;
  timestamp: number;
  expirySec: number;
}

interface Balance {
  outbound: number;
  inbound: number;
  settled: number;
}

export class RlnNetwork {
  readonly nodePubkey = {} as Record<ActorId, string>;
  readonly balance = {} as Record<ActorId, Balance>;
  private readonly invoices = new Map<string, Invoice>();
  /** payer → payment hash → payment */
  private readonly payments = new Map<ActorId, Map<string, Invoice>>();

  constructor(
    readonly assetId: string,
    private readonly nowMs: () => number,
  ) {
    for (const a of ACTORS) {
      this.nodePubkey[a] = `03${createHash('sha256').update(a).digest('hex')}`;
      // After the seed (B2): 50.00 out on the trip channel, 30.00 in on the liquidity channel.
      this.balance[a] =
        a === 'dave'
          ? { outbound: 9000, inbound: 15000, settled: 20000 }
          : { outbound: 5000, inbound: 3000, settled: 5000 };
      this.payments.set(a, new Map());
    }
  }

  /** The decoder the relay gets injected (the real relay decodes BOLT11 in JS). */
  decode(bolt11: string): DecodedInvoice {
    const i = this.invoices.get(bolt11);
    if (i === undefined) throw new Error('unknown invoice');
    return {
      bolt11,
      payeePubkey: this.nodePubkey[i.payee],
      paymentHash: i.paymentHash,
      assetId: this.assetId,
      cents: BigInt(i.cents),
      amtMsat: BigInt(HTLC_MIN_MSAT),
      description: i.description,
      expiresAt: new Date((i.timestamp + i.expirySec) * 1000).toISOString(),
    };
  }

  /** The `fetch` of one node's REST API. */
  fetchFor(node: ActorId): (req: Request) => Promise<Response> {
    return async (req) => {
      const endpoint = new URL(req.url).pathname;
      const raw = req.method === 'GET' ? '' : await req.text();
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const [status, json] = this.handle(node, endpoint, body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  private handle(node: ActorId, endpoint: string, b: Record<string, unknown>): [number, unknown] {
    const err = (status: number, name: string): [number, unknown] => [
      status,
      { error: name, code: status, name },
    ];
    switch (endpoint) {
      case '/nodeinfo':
        return [200, { pubkey: this.nodePubkey[node], rgb_htlc_min_msat: HTLC_MIN_MSAT }];
      case '/lninvoice': {
        if (b.asset_id !== this.assetId) return err(400, 'InvalidAssetID');
        const preimage = randomBytes(32).toString('hex');
        const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
        const invoice = `lnbcrtsim${node}${paymentHash.slice(0, 16)}`;
        this.invoices.set(invoice, {
          payee: node,
          paymentHash,
          preimage,
          cents: Number(b.asset_amount),
          description: String(b.description),
          timestamp: Math.floor(this.nowMs() / 1000),
          expirySec: Number(b.expiry_sec),
        });
        return [200, { invoice }];
      }
      case '/decodelninvoice': {
        const i = this.invoices.get(String(b.invoice));
        if (i === undefined) return err(400, 'InvalidInvoice');
        return [
          200,
          {
            amt_msat: HTLC_MIN_MSAT,
            expiry_sec: i.expirySec,
            timestamp: i.timestamp,
            asset_id: this.assetId,
            asset_amount: i.cents,
            description: i.description,
            payment_hash: i.paymentHash,
            payment_secret: 'ab'.repeat(32),
            payee_pubkey: this.nodePubkey[i.payee],
            network: 'Regtest',
          },
        ];
      }
      case '/assetbalance': {
        const x = this.balance[node];
        return [
          200,
          {
            settled: x.settled,
            future: x.settled,
            spendable: x.settled,
            offchain_outbound: x.outbound,
            offchain_inbound: x.inbound,
          },
        ];
      }
      case '/sendpayment': {
        const i = this.invoices.get(String(b.invoice));
        if (i === undefined) return err(400, 'InvalidInvoice');
        const mine = this.payments.get(node)!;
        if (mine.has(i.paymentHash)) return err(403, 'DuplicatePayment');
        if (this.balance[node].outbound < i.cents || this.balance[i.payee].inbound < i.cents)
          return err(403, 'InsufficientCapacity');
        this.balance[node].outbound -= i.cents;
        this.balance[node].inbound += i.cents;
        this.balance[i.payee].inbound -= i.cents;
        this.balance[i.payee].outbound += i.cents;
        mine.set(i.paymentHash, i);
        return [200, { payment_id: i.paymentHash, payment_hash: i.paymentHash, status: 'Pending' }];
      }
      case '/getpayment': {
        const i = this.payments.get(node)!.get(String(b.payment_hash));
        if (i === undefined) return err(400, 'PaymentNotFound');
        return [
          200,
          {
            payment: {
              amt_msat: HTLC_MIN_MSAT,
              asset_amount: i.cents,
              asset_id: this.assetId,
              payment_hash: i.paymentHash,
              inbound: false,
              status: 'Succeeded',
              created_at: 1,
              updated_at: 2,
              payee_pubkey: this.nodePubkey[i.payee],
              preimage: i.preimage,
            },
          },
        ];
      }
      default:
        return err(404, 'NotFound');
    }
  }
}
