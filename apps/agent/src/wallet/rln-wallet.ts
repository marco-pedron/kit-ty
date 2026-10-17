import { createHash, hkdfSync } from 'node:crypto';
import { createRlnClient, RlnError, toRlnError, type RlnClient } from '@kitty/rln-client';
import {
  ed25519PublicKeyHex,
  ed25519Sign,
  sha256Hex,
  type DecodedInvoice,
  type PaymentProof,
} from '@kitty/shared';
import { explorerTxUrl, type Esplora, type Miner } from './chain.js';
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
  /** /refreshtransfers before a balance read at most this often (default 15 s). */
  refreshEveryMs?: number;
  /** dave only (loadMemberWalletOptions sets it for dave): what closing channels needs. */
  coordinator?: CoordinatorChain;
}

export interface CoordinatorChain {
  esplora: Esplora;
  miner: Miner;
  /** Pause after each block so the nodes can see it and broadcast sweeps (default 1.5 s). */
  blockWaitMs?: number;
  /** How long a cooperative close may take to reach the mempool (default 60 s). */
  mempoolTimeoutMs?: number;
  /** How long to wait for the nodes to broadcast their sweeps before mining again (45 s). */
  sweepWaitMs?: number;
}

/** BTC capacity of a liquidity channel, as the seed's (SPEC §15). */
export const LIQUIDITY_CAPACITY_SAT = 1_000_000;
/** Confirmations before a channel is usable (SPEC §15: 6 blocks to open). */
const OPEN_CONFIRMATIONS = 6;
/** Blocks openLiquidity may mine: 6 confirmations plus margin. */
export const OPEN_BLOCK_BUDGET = 10;

/** Blocks closeChannelsWith may mine in all: 1 to confirm + ~6 for the sweep (SPEC §6.7). */
export const CLOSE_BLOCK_BUDGET = 12;

/**
 * Blocks after the confirming one before the nodes can sweep (LDK waits 6 confirmations).
 * Spike Q7: close confirmed at h164, sweep confirmed at h170.
 */
const SWEEP_DEPTH = 5;

export interface CloseResult {
  txids: string[];
  /** esplora REST /tx/<txid>, one per txid (SPEC §16 step 6). */
  explorerUrls: string[];
  /** Every output of the closing txs was swept and confirmed within the block budget. */
  swept: boolean;
  blocksMined: number;
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

type RlnChannel = {
  channel_id: string;
  peer_pubkey: string;
  status: string;
  funding_txid?: string | null;
  capacity_sat: number;
  ready?: boolean;
  is_usable?: boolean;
};

/** The funding output of a channel, whose spender is the closing tx. */
type ClosingChannel = { channelId: string; fundingTxid: string; vout: number };

const PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const NOT_FORCING = 'Not forcing a close: ask the member to come online and retry.';

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
  private openQueue: Promise<unknown> = Promise.resolve();
  private readonly refreshEveryMs: number;
  private lastRefreshAt = -Infinity;

  constructor(private readonly opts: RlnWalletOptions) {
    if (!HEX32.test(opts.appSecretHex)) throw new Error('appSecretHex must be 32 bytes of hex');
    this.rln = createRlnClient(opts.nodeUrl, opts.fetch ? { fetch: opts.fetch } : {});
    this.appSecretHex = opts.appSecretHex;
    this.appPubkey = ed25519PublicKeyHex(opts.appSecretHex);
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.payTimeoutMs = opts.payTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.refreshEveryMs = opts.refreshEveryMs ?? 15_000;
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

  /** /refreshtransfers with the body verified in the spike (Q7): settles incoming sweeps. */
  private async refreshTransfers(): Promise<void> {
    await this.call('/refreshtransfers', () =>
      this.rln.POST('/refreshtransfers', {
        body: { asset_id: null, filter: [], skip_sync: false },
      }),
    );
  }

  async balances(): Promise<WalletBalances> {
    try {
      // The DUSD of a closed channel come back on-chain with a sweep and only show after a
      // refresh (SPEC §6.7). Throttled; a failed refresh never hides the balance.
      if (this.now() - this.lastRefreshAt >= this.refreshEveryMs) {
        this.lastRefreshAt = this.now();
        await this.refreshTransfers().catch(() => undefined);
      }
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

  /**
   * dave only (SPEC §10.5): a new liquidity channel to the member with `cents` of dave's DUSD on
   * dave's side, same shape as the seed's (public, anchors, no fees, LIQUIDITY_CAPACITY_SAT).
   * Opens run one at a time (one DUSD allocation opens one channel at a time, B2); then mines
   * until the channel is usable, within OPEN_BLOCK_BUDGET blocks (regtest: seconds; production
   * would wait ~1 h for 6 confirmations, still less than the silent assent).
   */
  openLiquidity(peerPubkey: string, cents: bigint): Promise<{ channelId: string }> {
    const run = this.openQueue.then(() => this.openNow(peerPubkey, cents));
    this.openQueue = run.catch(() => undefined);
    return run;
  }

  private async openNow(peerPubkey: string, cents: bigint): Promise<{ channelId: string }> {
    const chain = this.opts.coordinator;
    if (!chain) throw new WalletError('NOT_ALLOWED', 'only dave opens liquidity channels');
    if (!PUBKEY.test(peerPubkey))
      throw new WalletError('VALIDATION_ERROR', `not a node pubkey: ${peerPubkey}`);
    if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER))
      throw new WalletError('VALIDATION_ERROR', `invalid liquidity amount ${cents}`);
    try {
      const channels = async () =>
        (await this.call('/listchannels', () => this.rln.GET('/listchannels')))
          .channels as RlnChannel[];
      const before = new Set((await channels()).map((c) => c.channel_id));
      const body = {
        peer_pubkey_and_opt_addr: peerPubkey,
        capacity_sat: LIQUIDITY_CAPACITY_SAT,
        push_msat: 0,
        asset_amount: Number(cents),
        asset_id: this.opts.assetId,
        public: true,
        with_anchors: true,
        fee_base_msat: 0,
        fee_proportional_millionths: 0,
      };
      let blocksMined = 0;
      const mine = async (n: number) => {
        const height = await chain.miner.mine(n);
        blocksMined += n;
        const deadline = this.now() + 30_000;
        while ((await chain.esplora.tipHeight()) < height) {
          if (this.now() >= deadline)
            throw new WalletError('INTERNAL', `esplora did not reach height ${height} in 30 s`);
          await sleep(this.pollIntervalMs);
        }
        await sleep(chain.blockWaitMs ?? 1_500);
      };
      // A transient refusal (an indexer miss, dave's previous change not confirmed): one block,
      // then retry, as the seed does.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.call('/openchannel', () => this.rln.POST('/openchannel', { body }));
          break;
        } catch (e) {
          if (!(e instanceof RlnError) || attempt >= 3) throw e;
          await mine(1);
        }
      }
      const fresh = async () =>
        (await channels()).find((c) => !before.has(c.channel_id) && c.peer_pubkey === peerPubkey);
      const deadline = this.now() + (chain.mempoolTimeoutMs ?? 60_000);
      for (;;) {
        const c = await fresh();
        if (c?.funding_txid && (await chain.esplora.tx(c.funding_txid)) !== null) break;
        if (this.now() >= deadline)
          throw new WalletError(
            'INTERNAL',
            `the liquidity channel to ${peerPubkey} was not funded in time`,
            'Retry; if it fails again, check the node of dave.',
          );
        await sleep(this.pollIntervalMs * 4);
      }
      // The 6 confirmations in one go, as the seed does; then a block at a time if needed.
      await mine(OPEN_CONFIRMATIONS);
      for (;;) {
        const c = await fresh();
        if (c?.ready && c.is_usable) return { channelId: c.channel_id };
        if (blocksMined >= OPEN_BLOCK_BUDGET)
          throw new WalletError(
            'INTERNAL',
            `the liquidity channel to ${peerPubkey} is not usable after ${blocksMined} blocks`,
          );
        await mine(1);
      }
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  /**
   * dave only (SPEC §6.7): cooperative close of every channel with the member (trip and
   * liquidity), then mines until the closes confirm and their outputs are swept, within
   * CLOSE_BLOCK_BUDGET blocks. Never a forced close: if the peer cannot cooperate, it fails.
   */
  async closeChannelsWith(peerPubkey: string): Promise<CloseResult> {
    const chain = this.opts.coordinator;
    if (!chain) throw new WalletError('NOT_ALLOWED', 'only dave closes channels with a member');
    if (!PUBKEY.test(peerPubkey))
      throw new WalletError('VALIDATION_ERROR', `not a node pubkey: ${peerPubkey}`);
    try {
      const targets = await this.closingChannels(chain, peerPubkey);
      const txids = await this.closeCooperatively(chain, peerPubkey, targets);
      const { swept, blocksMined } = await this.mineUntilSwept(chain, txids);
      // dave's own share of the closes (the liquidity channel) settles on his node too.
      await this.refreshTransfers().catch(() => undefined);
      return {
        txids,
        explorerUrls: txids.map((t) => explorerTxUrl(chain.esplora, t)),
        swept,
        blocksMined,
      };
    } catch (e) {
      throw toWalletError(e, 'other');
    }
  }

  /** Checks before closing anything: the member is online and every channel is Opened. */
  private async closingChannels(
    chain: CoordinatorChain,
    peerPubkey: string,
  ): Promise<ClosingChannel[]> {
    const [{ channels }, { peers }] = await Promise.all([
      this.call('/listchannels', () => this.rln.GET('/listchannels')),
      this.call('/listpeers', () => this.rln.GET('/listpeers')),
    ]);
    const mine = (channels as RlnChannel[]).filter((c) => c.peer_pubkey === peerPubkey);
    if (mine.length === 0)
      throw new WalletError('NOT_FOUND', `dave has no channel with ${peerPubkey}`);
    if (!peers.some((p) => p.pubkey === peerPubkey))
      throw new WalletError(
        'RECEIVER_UNREACHABLE',
        `the node ${peerPubkey} is not connected to dave: a cooperative close needs both online`,
        NOT_FORCING,
      );
    const out: ClosingChannel[] = [];
    for (const c of mine) {
      if (c.status !== 'Opened' || !c.funding_txid)
        throw new WalletError(
          'INTERNAL',
          `channel ${c.channel_id} is ${c.status}, not Opened: nothing was closed`,
          'Wait for the channel to settle, then retry.',
        );
      const tx = await chain.esplora.tx(c.funding_txid);
      const vouts = (tx?.vout ?? []).flatMap((o, i) =>
        o.value === c.capacity_sat && o.scriptpubkey_type === 'v0_p2wsh' ? [i] : [],
      );
      if (vouts.length !== 1 || vouts[0] === undefined)
        throw new WalletError(
          'INTERNAL',
          `cannot find the funding output of channel ${c.channel_id} in ${c.funding_txid}`,
        );
      out.push({ channelId: c.channel_id, fundingTxid: c.funding_txid, vout: vouts[0] });
    }
    return out;
  }

  /** /closechannel force:false one by one, then waits for each closing tx in the mempool. */
  private async closeCooperatively(
    chain: CoordinatorChain,
    peerPubkey: string,
    targets: ClosingChannel[],
  ): Promise<string[]> {
    const requested: ClosingChannel[] = [];
    for (const t of targets) {
      try {
        await this.call('/closechannel', () =>
          this.rln.POST('/closechannel', {
            body: { channel_id: t.channelId, peer_pubkey: peerPubkey, force: false },
          }),
        );
      } catch (e) {
        const done = requested.map((r) => r.channelId).join(', ') || 'none';
        const why = e instanceof Error ? e.message : String(e);
        throw new WalletError(
          'INTERNAL',
          `cooperative close of channel ${t.channelId} refused (${why}); already closing: ${done}`,
          NOT_FORCING,
        );
      }
      requested.push(t);
    }

    const timeoutMs = chain.mempoolTimeoutMs ?? 60_000;
    const deadline = this.now() + timeoutMs;
    const txids = new Map<string, string>();
    for (;;) {
      for (const t of requested) {
        if (txids.has(t.channelId)) continue;
        const spend = (await chain.esplora.outspends(t.fundingTxid))[t.vout];
        if (spend?.spent && spend.txid) txids.set(t.channelId, spend.txid);
      }
      if (txids.size === requested.length)
        return requested.flatMap((t) => txids.get(t.channelId) ?? []);
      if (this.now() >= deadline) {
        const missing = requested.filter((t) => !txids.has(t.channelId)).map((t) => t.channelId);
        throw new WalletError(
          'INTERNAL',
          `no closing tx after ${timeoutMs} ms for ${missing.join(', ')}; ` +
            `closing txs seen: ${[...txids.values()].join(', ') || 'none'}`,
          NOT_FORCING,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** Mines one block at a time: first until the closes confirm, then until they are swept. */
  private async mineUntilSwept(
    chain: CoordinatorChain,
    txids: string[],
  ): Promise<{ swept: boolean; blocksMined: number }> {
    const blockWaitMs = chain.blockWaitMs ?? 1_500;
    let blocksMined = 0;
    const mineOne = async () => {
      const height = await chain.miner.mine(1);
      blocksMined += 1;
      const deadline = this.now() + 30_000;
      while ((await chain.esplora.tipHeight()) < height) {
        if (this.now() >= deadline)
          throw new WalletError('INTERNAL', `esplora did not reach height ${height} in 30 s`);
        await sleep(this.pollIntervalMs);
      }
      await sleep(blockWaitMs);
    };

    const confirmed = async () => {
      for (const t of txids) if (!(await chain.esplora.tx(t))?.status.confirmed) return false;
      return true;
    };
    while (!(await confirmed())) {
      if (blocksMined >= CLOSE_BLOCK_BUDGET)
        throw new WalletError(
          'INTERNAL',
          `closing txs ${txids.join(', ')} not confirmed after ${blocksMined} blocks`,
        );
      await mineOne();
    }

    // Mine to the sweep depth, then let the nodes see it and broadcast: mining faster than
    // they sync wastes blocks (first run on regtest: sweep 10 blocks after the close).
    const confirmedAt = blocksMined;
    while (blocksMined - confirmedAt < SWEEP_DEPTH && blocksMined < CLOSE_BLOCK_BUDGET)
      await mineOne();

    // Each spendable output of the closing txs: spent by a confirmed tx, in the mempool, or not.
    const sweepState = async (): Promise<'confirmed' | 'mempool' | 'unspent'> => {
      let state: 'confirmed' | 'mempool' = 'confirmed';
      for (const t of txids) {
        const tx = await chain.esplora.tx(t);
        const spends = await chain.esplora.outspends(t);
        for (const [i, o] of (tx?.vout ?? []).entries()) {
          if (o.scriptpubkey_type === 'op_return') continue;
          if (!spends[i]?.spent) return 'unspent';
          if (!spends[i]?.status?.confirmed) state = 'mempool';
        }
      }
      return state;
    };
    const sweepWaitMs = chain.sweepWaitMs ?? 45_000;
    let waitingSince = this.now();
    for (;;) {
      const state = await sweepState();
      if (state === 'confirmed') break;
      if (state === 'unspent' && this.now() - waitingSince < sweepWaitMs) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      // sweeps in the mempool (or not broadcast in time): one more block, if the budget allows
      if (blocksMined >= CLOSE_BLOCK_BUDGET) return { swept: false, blocksMined };
      await mineOne();
      waitingSince = this.now();
    }
    return { swept: true, blocksMined };
  }

  async backupNow(): Promise<{ version: string }> {
    throw new WalletError('NOT_IMPLEMENTED', 'backupNow is not implemented in B3 (task B6)');
  }
}
