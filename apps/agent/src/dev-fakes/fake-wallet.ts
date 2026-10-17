import { fakeSign, sha256Hex, type DecodedInvoice, type PaymentProof } from '@kitty/shared';
import { WalletError } from '../wallet/errors.js';
import type { Wallet, WalletBalances } from '../wallet/types.js';
import { assertFakesOn } from './guard.js';

// DEV ONLY (KITTY_FAKES=1): an in-memory Lightning network with one hub (dave), so a fake
// invoice created by alice's wallet can be paid by bob's. Real hashes: paymentHash =
// sha256(preimage), so proofs verify like real ones. No node, no chain, no RGB.

type FakeInvoice = DecodedInvoice & { preimage: string; paid: boolean };

type Account = { name: string; nodePubkey: string; appPubkey: string } & WalletBalances;

const randomHex = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');

export class FakeLightningNetwork {
  readonly invoices = new Map<string, FakeInvoice>();
  readonly accounts = new Map<string, Account>();
  private txCounter = 0;

  constructor(readonly assetId = 'rgb:fake-dusd') {
    assertFakesOn('FakeLightningNetwork');
  }

  /** Demo opening state (SPEC §15): D = 50.00 in the trip channel, L = 30.00 to receive. */
  wallet(
    name: string,
    start: WalletBalances = { tripOutboundCents: 5000n, inboundCents: 3000n, onchainCents: 5000n },
  ): FakeWallet {
    if (!this.accounts.has(name)) {
      this.accounts.set(name, {
        name,
        nodePubkey: `02${sha256Hex(`fake-node:${name}`)}`,
        appPubkey: sha256Hex(`fake-app:${name}`),
        ...start,
      });
    }
    return new FakeWallet(this, name);
  }

  account(name: string): Account {
    const a = this.accounts.get(name);
    if (!a) throw new WalletError('NODE_UNREACHABLE', `fake node ${name} does not exist`);
    return a;
  }

  byNode(nodePubkey: string): Account {
    for (const a of this.accounts.values()) if (a.nodePubkey === nodePubkey) return a;
    throw new WalletError('RECEIVER_UNREACHABLE', `no fake node ${nodePubkey}`);
  }

  fakeTxid(): string {
    return sha256Hex(`fake-tx:${++this.txCounter}`);
  }
}

export class FakeWallet implements Wallet {
  readonly engine = 'rln-rest' as const;
  private backups = 0;

  constructor(
    private readonly net: FakeLightningNetwork,
    readonly member: string,
  ) {
    assertFakesOn('FakeWallet');
  }

  private get me(): Account {
    return this.net.account(this.member);
  }

  async nodePubkey(): Promise<string> {
    return this.me.nodePubkey;
  }

  async authorPubkey(): Promise<string> {
    return this.me.appPubkey;
  }

  async sign(message: string): Promise<string> {
    return fakeSign(this.me.appPubkey, message);
  }

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
    const preimage = randomHex(32);
    const paymentHash = sha256Hex(Buffer.from(preimage, 'hex'));
    const bolt11 = `lnbcrtfake${paymentHash}`;
    this.net.invoices.set(bolt11, {
      bolt11,
      payeePubkey: this.me.nodePubkey,
      paymentHash,
      assetId: this.net.assetId,
      cents: p.cents,
      amtMsat: 3_000_000n,
      description: p.description,
      expiresAt: new Date(Date.now() + p.expirySec * 1000).toISOString(),
      preimage,
      paid: false,
    });
    return { bolt11, paymentHash };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const inv = this.net.invoices.get(bolt11);
    if (!inv) throw new WalletError('VALIDATION_ERROR', 'unknown fake invoice');
    return {
      bolt11: inv.bolt11,
      payeePubkey: inv.payeePubkey,
      paymentHash: inv.paymentHash,
      assetId: inv.assetId,
      cents: inv.cents,
      amtMsat: inv.amtMsat,
      description: inv.description,
      expiresAt: inv.expiresAt,
    };
  }

  async pay(bolt11: string): Promise<PaymentProof> {
    const inv = this.net.invoices.get(bolt11);
    if (!inv) throw new WalletError('PAYMENT_FAILED', 'unknown fake invoice');
    if (inv.paid) throw new WalletError('PAYMENT_FAILED', 'fake invoice already paid');
    if (Date.parse(inv.expiresAt) <= Date.now())
      throw new WalletError('INVOICE_EXPIRED', 'fake invoice expired');
    const cents = inv.cents ?? 0n;
    const payer = this.me;
    const payee = this.net.byNode(inv.payeePubkey);
    if (payer.tripOutboundCents < cents)
      throw new WalletError(
        'TOPUP_REQUIRED',
        `fake channel has ${payer.tripOutboundCents}, needs ${cents}`,
      );
    if (payee.inboundCents < cents)
      throw new WalletError('PAYMENT_FAILED', `${payee.name} cannot receive ${cents} now`);
    await new Promise((r) => setTimeout(r, 50));
    payer.tripOutboundCents -= cents;
    payer.inboundCents += cents;
    payee.inboundCents -= cents;
    payee.tripOutboundCents += cents;
    inv.paid = true;
    return {
      rail: 'ln',
      paymentHash: inv.paymentHash,
      preimage: inv.preimage,
      cents,
      payeePubkey: inv.payeePubkey,
    };
  }

  async balances(): Promise<WalletBalances> {
    const { tripOutboundCents, inboundCents, onchainCents } = this.me;
    return { tripOutboundCents, inboundCents, onchainCents };
  }

  async openLiquidity(peerPubkey: string, cents: bigint): Promise<{ channelId: string }> {
    this.net.byNode(peerPubkey).inboundCents += cents;
    return { channelId: `fake-ch-${this.net.fakeTxid().slice(0, 16)}` };
  }

  async closeChannelsWith(peerPubkey: string): Promise<{ txids: string[] }> {
    const peer = this.net.byNode(peerPubkey);
    peer.onchainCents += peer.tripOutboundCents;
    peer.tripOutboundCents = 0n;
    peer.inboundCents = 0n;
    return { txids: [this.net.fakeTxid(), this.net.fakeTxid()] };
  }

  async backupNow(): Promise<{ version: string; blob: Uint8Array }> {
    const version = `fake-${++this.backups}`;
    return { version, blob: new TextEncoder().encode(version) };
  }
}
