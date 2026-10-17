import type { RailMode } from '@kitty/shared';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';
import type { PaymentRequest, Rail } from './types.js';

// The Lightning rail (`ln-2ch`, SPEC §10.1, §10.4): the creditor's wallet issues an RGB
// invoice, the debtor's wallet pays it through dave. One instance per member wallet.
export class LightningRail implements Rail {
  constructor(
    private readonly wallet: Wallet,
    readonly mode: Exclude<RailMode, 'onchain'> = 'ln-2ch',
  ) {}

  async requestPayment(p: {
    cents: bigint;
    description: string;
    expirySec: number;
  }): Promise<PaymentRequest> {
    const { bolt11, paymentHash } = await this.wallet.createInvoice(p);
    const { expiresAt } = await this.wallet.decodeInvoice(bolt11);
    return { rail: 'ln', bolt11, paymentHash, expiresAt: new Date(expiresAt) };
  }

  async pay(req: PaymentRequest) {
    if (req.rail !== 'ln')
      throw new WalletError(
        'VALIDATION_ERROR',
        'the Lightning rail cannot pay an on-chain request',
      );
    const proof = await this.wallet.pay(req.bolt11);
    if (proof.rail !== 'ln' || proof.paymentHash !== req.paymentHash)
      throw new WalletError('INTERNAL', 'the proof does not match the payment request');
    return proof;
  }
}
