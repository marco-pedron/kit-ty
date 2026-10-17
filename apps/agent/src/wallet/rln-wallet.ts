import { createHash, hkdfSync } from 'node:crypto';
import { createRlnClient, RlnError, toRlnError, type RlnClient } from '@kitty/rln-client';
import {
  ed25519PublicKeyHex,
  ed25519Sign,
  sha256Hex,
  type DecodedInvoice,
  type PaymentProof,
} from '@kitty/shared';
import { toWalletError, WalletError } from './errors.js';
import type { Wallet, WalletBalances } from './types.js';

// The real Wallet of one member, motore `rln-rest` (gate 2, SPEC §14.0, §20): the member's own
// rgb-lightning-node (d4762ac) over REST, plus the ed25519 app key that signs events (§9.1).
// Calls and parameters are the ones verified in docs/spike-lightning.md.

export interface RlnWalletOptions {
  /** This member's node API, e.g. http://127.0.0.1:3002. Never another member's. */
  nodeUrl: string;
  /** 32-byte ed25519 secret, lowercase hex (see deriveAppSecretHex). */
  appSecretHex: string;
  /** DUSD asset id of the trip (infra/.out/seed-state.json). */
  assetId: string;
  fetch?: (input: Request) => Promise<Response>;
  /** /getpayment polling interval (SPEC §10.1: 250 ms). */
  pollIntervalMs?: number;
  /** Default pay timeout (SPEC §10.1: 30 s). */
  payTimeoutMs?: number;
  now?: () => number;
}

/** An invoice expiring within this window is treated as expired: a payment takes seconds. */
export const EXPIRY_MARGIN_MS = 5_000;

const HEX32 = /^[0-9a-f]{64}$/;
const APP_KEY_SALT = 'kitty-app-key-v1';
const APP_KEY_INFO = 'ed25519';

/** Trim, single spaces, lowercase, NFKD (as BIP-39 does), so the same words give the same key. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().split(/\s+/u).join(' ').toLowerCase();
}

/**
 * The member's app key, derived from their node mnemonic with HKDF-SHA256 (decision B3,
 * option A): no extra secret to store, and restoring the node keeps the same event author.
 */
export function deriveAppSecretHex(mnemonic: string): string {
  const words = normalizeMnemonic(mnemonic);
  if (words === '') throw new Error('empty mnemonic');
  const key = hkdfSync('sha256', words, APP_KEY_SALT, APP_KEY_INFO, 32);
  return Buffer.from(key).toString('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeBigInt(n: unknown, field: string): bigint {
  if (typeof n !== 'number' || !Number.isSafeInteger(n))
    throw new WalletError('INTERNAL', `node returned a non-integer ${field}: ${String(n)}`);
  return BigInt(n);
}

/** /sendpayment failures after which the payment may or may not have left the node. */
function sendOutcomeUnknown(e: RlnError): boolean {
  return (
    e.rlnName === 'DuplicatePayment' ||
    e.rlnName === 'Unknown' ||
    e.rlnName === 'Unreachable' ||
    e.status >= 500
  );
}

export type LnProof = Extract<PaymentProof, { rail: 'ln' }>;

type RlnPayment = {
  payment_hash: string;
  inbound: boolean;
  status: 'Pending' | 'Succeeded' | 'Failed';
  payee_pubkey: string;
  preimage?: string | null;
  asset_id?: string | null;
  asset_amount?: number | null;
};

export class RlnWallet implements Wallet {
  readonly engine = 'rln-rest' as const;
  private readonly rln: RlnClient;
  private readonly appSecretHex: string;
  private readonly appPubkey: string;
  private readonly pollIntervalMs: number;
  private readonly payTimeoutMs: number;
  private readonly now: () => number;
  private nodeInfo: Promise<{ pubkey: string; htlcMinMsat: number }> | null = null;
  /** Payments of one member run one at a time (in-flight value limit, SPEC §10.1, §20). */
  private payQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RlnWalletOptions) {
    if (!HEX32.test(opts.appSecretHex)) throw new Error('appSecretHex must be 32 bytes of hex');
    this.rln = createRlnClient(opts.nodeUrl, opts.fetch ? { fetch: opts.fetch } : {});
    this.appSecretHex = opts.appSecretHex;
    this.appPubkey = ed25519PublicKeyHex(opts.appSecretHex);
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.payTimeoutMs = opts.payTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** One REST call: network failure → RlnError 'Unreachable', non-2xx → RlnError from body. */
  private async call<T>(
    endpoint: string,
    send: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    let r: { data?: T; error?: unknown; response: Response };
    try {
      r = await send();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof TypeError ? 'Unreachable' : 'Unknown';
      throw new RlnError(endpoint, 0, name, msg);
    }
    if (!r.response.ok || r.data === undefined)
      throw toRlnError(endpoint, r.response.status, r.error);
    return r.data;
  }

  private getNodeInfo(): Promise<{ pubkey: string; htlcMinMsat: number }> {
    this.nodeInfo ??= this.call('/nodeinfo', () => this.rln.GET('/nodeinfo')).then((i) => {
      if (typeof i.pubkey !== 'string' || !Number.isSafeInteger(i.rgb_htlc_min_msat))
        throw new WalletError('INTERNAL', '/nodeinfo returned an unexpected body');
      return { pubkey: i.pubkey, htlcMinMsat: i.rgb_htlc_min_msat };
    });
    // A failed lookup (node locked, down) is retried on the next call, not cached.
    this.nodeInfo.catch(() => (this.nodeInfo = null));
    return this.nodeInfo;
  }

  async nodePubkey(): Promise<string> {
    try {
      return (await this.getNodeInfo()).pubkey;
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  async authorPubkey(): Promise<string> {
    return this.appPubkey;
  }

  /** ed25519 over the UTF-8 of message (B4 format). Never RLN /signmessage (SPEC §9.1). */
  async sign(message: string): Promise<string> {
    return ed25519Sign(this.appSecretHex, message);
  }

  /** Same description as the FakeWallet; checked by checkBindInvoice (SPEC §9.1). */
  async bindInvoice(appPubkey: string): Promise<string> {
    const { bolt11 } = await this.createInvoice({
      cents: 1n,
      description: `kitty-bind:${sha256Hex(appPubkey)}`,
      expirySec: 3600,
    });
    return bolt11;
  }

  async createInvoice(p: {
    cents: bigint;
    description: string;
    expirySec: number;
  }): Promise<{ bolt11: string; paymentHash: string }> {
    if (p.cents <= 0n || p.cents > BigInt(Number.MAX_SAFE_INTEGER))
      throw new WalletError('VALIDATION_ERROR', `invalid invoice amount ${p.cents}`);
    if (!Number.isSafeInteger(p.expirySec) || p.expirySec <= 0)
      throw new WalletError('VALIDATION_ERROR', `invalid invoice expiry ${p.expirySec}`);
    try {
      const { htlcMinMsat, pubkey } = await this.getNodeInfo();
      const { invoice } = await this.call('/lninvoice', () =>
        this.rln.POST('/lninvoice', {
          body: {
            amt_msat: htlcMinMsat,
            expiry_sec: p.expirySec,
            asset_id: this.opts.assetId,
            asset_amount: Number(p.cents),
            description: p.description,
          },
        }),
      );
      if (typeof invoice !== 'string' || invoice === '')
        throw new WalletError('INTERNAL', '/lninvoice returned no invoice');
      const decoded = await this.decodeInvoice(invoice);
      if (decoded.payeePubkey !== pubkey || decoded.cents !== p.cents)
        throw new WalletError('INTERNAL', 'the node created an invoice that does not match');
      return { bolt11: invoice, paymentHash: decoded.paymentHash };
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    try {
      const d = await this.call('/decodelninvoice', () =>
        this.rln.POST('/decodelninvoice', { body: { invoice: bolt11 } }),
      );
      if (typeof d.payee_pubkey !== 'string' || typeof d.payment_hash !== 'string')
        throw new WalletError('INTERNAL', '/decodelninvoice returned an unexpected body');
      const expiresMs = (Number(d.timestamp) + Number(d.expiry_sec)) * 1000;
      if (!Number.isFinite(expiresMs))
        throw new WalletError('INTERNAL', '/decodelninvoice returned no expiry');
      return {
        bolt11,
        payeePubkey: d.payee_pubkey,
        paymentHash: d.payment_hash,
        assetId: d.asset_id ?? null,
        cents: d.asset_amount == null ? null : safeBigInt(d.asset_amount, 'asset_amount'),
        amtMsat: d.amt_msat == null ? null : safeBigInt(d.amt_msat, 'amt_msat'),
        description: d.description ?? '',
        expiresAt: new Date(expiresMs).toISOString(),
      };
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  private async assetBalance() {
    const b = await this.call('/assetbalance', () =>
      this.rln.POST('/assetbalance', { body: { asset_id: this.opts.assetId } }),
    );
    return {
      settled: safeBigInt(b.settled, 'settled'),
      offchainOutbound: safeBigInt(b.offchain_outbound, 'offchain_outbound'),
      offchainInbound: safeBigInt(b.offchain_inbound, 'offchain_inbound'),
    };
  }

  async balances(): Promise<WalletBalances> {
    try {
      const b = await this.assetBalance();
      return {
        tripOutboundCents: b.offchainOutbound,
        inboundCents: b.offchainInbound,
        onchainCents: b.settled,
      };
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  pay(bolt11: string, opts: { timeoutMs?: number } = {}): Promise<LnProof> {
    const run = this.payQueue.then(() => this.payNow(bolt11, opts.timeoutMs ?? this.payTimeoutMs));
    this.payQueue = run.catch(() => undefined);
    return run;
  }

  private async payNow(bolt11: string, timeoutMs: number): Promise<LnProof> {
    try {
      // 1. Checks before anything leaves the node.
      const inv = await this.decodeInvoice(bolt11);
      if (Date.parse(inv.expiresAt) <= this.now() + EXPIRY_MARGIN_MS)
        throw new WalletError('INVOICE_EXPIRED', `invoice expired at ${inv.expiresAt}`);
      if (inv.assetId !== this.opts.assetId)
        throw new WalletError(
          'VALIDATION_ERROR',
          `invoice asset ${inv.assetId} is not the trip asset`,
        );
      if (inv.cents === null || inv.cents <= 0n)
        throw new WalletError('VALIDATION_ERROR', 'invoice has no DUSD amount');
      const { offchainOutbound } = await this.assetBalance();
      if (offchainOutbound < inv.cents)
        throw new WalletError(
          'TOPUP_REQUIRED',
          `channel has ${offchainOutbound} cents to send, the invoice asks ${inv.cents}`,
        );

      // 2. Send. If the answer does not tell whether it left (network error, 5xx, a body we
      // cannot read) or says it was already sent (DuplicatePayment, a retry), ask the node.
      try {
        const sent = await this.call('/sendpayment', () =>
          this.rln.POST('/sendpayment', { body: { invoice: bolt11 } }),
        );
        if (sent.status === 'Failed')
          throw new WalletError('PAYMENT_FAILED', 'the node could not send the payment');
      } catch (e) {
        if (!(e instanceof RlnError && sendOutcomeUnknown(e))) throw e;
      }

      // 3. Wait for the final state, then check the proof before calling it paid.
      const payment = await this.waitForPayment(inv.paymentHash, timeoutMs);
      return this.proofOf(inv, payment);
    } catch (e) {
      throw toWalletError(e, 'pay');
    }
  }

  /** /getpayment every pollIntervalMs. Transient errors are retried: the HTLC may be moving. */
  private async waitForPayment(paymentHash: string, timeoutMs: number): Promise<RlnPayment> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      let lastError = '';
      try {
        const { payment } = await this.call('/getpayment', () =>
          this.rln.POST('/getpayment', { body: { payment_hash: paymentHash } }),
        );
        if (payment.status === 'Succeeded') return payment;
        if (payment.status === 'Failed')
          throw new WalletError('PAYMENT_FAILED', 'the payment failed on the route');
      } catch (e) {
        if (e instanceof WalletError) throw e;
        if (e instanceof RlnError && e.rlnName === 'PaymentNotFound')
          throw new WalletError(
            'PAYMENT_FAILED',
            'the node has no record of this payment: not sent',
          );
        lastError = e instanceof Error ? `: last error ${e.message}` : '';
      }
      if (this.now() >= deadline)
        throw new WalletError(
          'PAYMENT_FAILED',
          `payment still pending after ${timeoutMs} ms${lastError}`,
          'The payment is still pending and may complete. Do not pay again; check again in a moment.',
        );
      await sleep(this.pollIntervalMs);
    }
  }

  private proofOf(inv: DecodedInvoice, p: RlnPayment): LnProof {
    const preimage = p.preimage ?? '';
    const problems: string[] = [];
    if (p.inbound) problems.push('payment is inbound');
    if (p.payment_hash !== inv.paymentHash) problems.push('payment hash differs from the invoice');
    if (!HEX32.test(preimage)) problems.push('missing preimage');
    else if (
      createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== inv.paymentHash
    )
      problems.push('sha256(preimage) != payment hash');
    if (p.asset_id !== this.opts.assetId) problems.push('asset differs');
    if (p.asset_amount == null || BigInt(p.asset_amount) !== inv.cents)
      problems.push('amount differs');
    if (p.payee_pubkey !== inv.payeePubkey) problems.push('payee differs');
    if (problems.length > 0 || inv.cents === null)
      throw new WalletError('INTERNAL', `payment reported as succeeded but ${problems.join(', ')}`);
    return {
      rail: 'ln',
      paymentHash: inv.paymentHash,
      preimage,
      cents: inv.cents,
      payeePubkey: inv.payeePubkey,
    };
  }

  async openLiquidity(): Promise<{ channelId: string }> {
    throw new WalletError('NOT_IMPLEMENTED', 'openLiquidity is not implemented in B3 (task B9)');
  }

  async closeChannelsWith(): Promise<{ txids: string[] }> {
    throw new WalletError(
      'NOT_IMPLEMENTED',
      'closeChannelsWith is not implemented in B3 (task B7)',
    );
  }

  async backupNow(): Promise<{ version: string }> {
    throw new WalletError('NOT_IMPLEMENTED', 'backupNow is not implemented in B3 (task B6)');
  }
}
