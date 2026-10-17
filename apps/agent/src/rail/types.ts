// OWNED BY STREAM B (PLAN.md §2): LightningRail is task B3, OnchainRail task B5.
// One interface for every way of paying a line, so the mode is configuration (SPEC §10.4).
import type { PaymentProof, RailMode } from '@kitty/shared';

/** What the creditor hands to the debtor. In RGB the receiver acts first. */
export type PaymentRequest =
  | { rail: 'ln'; bolt11: string; paymentHash: string; expiresAt: Date }
  | { rail: 'onchain'; invoice: string; recipientId: string; expiresAt: Date };

export interface Rail {
  readonly mode: RailMode;
  /** Runs on the creditor's wallet. */
  requestPayment(p: {
    cents: bigint;
    description: string;
    expirySec: number;
  }): Promise<PaymentRequest>;
  /** Runs on the debtor's wallet; resolves only when settled, with a verifiable proof. */
  pay(req: PaymentRequest): Promise<PaymentProof>;
}
