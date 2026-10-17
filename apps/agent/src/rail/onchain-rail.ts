import type { PaymentProof } from '@kitty/shared';
import type { Esplora, Miner } from '../wallet/chain.js';
import { WalletError } from '../wallet/errors.js';
import type { RlnWallet } from '../wallet/rln-wallet.js';
import type { PaymentRequest, Rail } from './types.js';

// The on-chain RGB rail (task B5, SPEC §10.3), adapted from the old project's rail: the
// creditor's node issues a blinded-UTXO RGB invoice, the debtor's node sends one witness
// transaction, a block confirms it. Used to pay an excluded member (no channels any more),
// or as the whole `onchain` mode. The proof is the txid, checkable on esplora (/tx/<txid>).

export interface OnchainRailOptions {
  esplora: Esplora;
  /** Regtest: who mines the confirming block (dave's miner in the demo). */
  miner: Miner;
  /** How long to wait for the witness tx on esplora, then for its confirmation (default 60 s). */
  timeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OnchainRail implements Rail {
  readonly mode = 'onchain' as const;

  constructor(
    private readonly wallet: RlnWallet,
    private readonly opts: OnchainRailOptions,
  ) {}

  /** Runs on the creditor's wallet. */
  async requestPayment(p: {
    cents: bigint;
    description: string;
    expirySec: number;
  }): Promise<PaymentRequest> {
    const r = await this.wallet.createRgbInvoice({ cents: p.cents, expirySec: p.expirySec });
    return {
      rail: 'onchain',
      invoice: r.invoice,
      recipientId: r.recipientId,
      cents: p.cents,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * Runs on the debtor's wallet: sends, mines one block, and resolves once the witness tx is
   * confirmed and the transfer did not fail. The creditor's node settles it at its next refresh.
   */
  async pay(req: PaymentRequest): Promise<PaymentProof> {
    if (req.rail !== 'onchain')
      throw new WalletError('VALIDATION_ERROR', 'the on-chain rail cannot pay a Lightning invoice');
    const { cents } = req;
    if (req.expiresAt.getTime() <= Date.now())
      throw new WalletError('INVOICE_EXPIRED', 'the on-chain payment request expired');
    const txid = await this.wallet.sendRgb({ recipientId: req.recipientId, cents });
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const pollMs = this.opts.pollMs ?? 1_000;

    const until = async (what: string, ok: () => Promise<boolean>) => {
      const end = Date.now() + timeoutMs;
      while (!(await ok())) {
        if (Date.now() > end) throw new WalletError('PAYMENT_FAILED', `${what} (txid ${txid})`);
        await sleep(pollMs);
      }
    };
    await until(
      'the witness tx never reached the mempool',
      async () => (await this.opts.esplora.tx(txid)) !== null,
    );
    await this.opts.miner.mine(1);
    await until(
      'the witness tx was not confirmed',
      async () => (await this.opts.esplora.tx(txid))?.status.confirmed === true,
    );
    if ((await this.wallet.rgbTransferStatus({ send: txid })) === 'Failed')
      throw new WalletError('PAYMENT_FAILED', `the RGB transfer failed (txid ${txid})`);
    return { rail: 'onchain', txid, cents };
  }
}
