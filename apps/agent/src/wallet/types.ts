// OWNED BY STREAM B (PLAN.md §2): the real implementation is task B3. Interface fixed by the
// contract session (SPEC §14.2). An agent receives only its own member's Wallet.
import type { DecodedInvoice, PaymentProof } from '@kitty/shared';

export type WalletEngine = 'wdk' | 'rln-rest';

export interface WalletBalances {
  /**
   * DUSD this member can spend over Lightning now: the trip channel, plus what they received
   * on the liquidity channel (spendable too). "Only you can spend it".
   */
  tripOutboundCents: bigint;
  /** DUSD this member can receive now: dave's side of their channels (SPEC §10.5). */
  inboundCents: bigint;
  /** DUSD on-chain on the member's node (seed on-ramp, swept channel closes). */
  onchainCents: bigint;
}

export interface Wallet {
  /** `rln-rest` in the demo (gate 2, SPEC §20); `wdk` stays in the union, unused. */
  readonly engine: WalletEngine;
  /** Lightning node key: the payee_pubkey of this member's invoices. */
  nodePubkey(): Promise<string>;
  /** Event author key: the ed25519 appPubkey with rln-rest (= nodePubkey with wdk). */
  authorPubkey(): Promise<string>;
  /** Signs signingMessage(inner) (SPEC §9.1). Never RLN /signmessage. */
  sign(message: string): Promise<string>;
  /** rln-rest: invoice with description `kitty-bind:<sha256(appPubkey)>`; null with wdk. */
  bindInvoice(appPubkey: string): Promise<string | null>;
  createInvoice(p: {
    cents: bigint;
    description: string;
    expirySec: number;
  }): Promise<{ bolt11: string; paymentHash: string }>;
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;
  /**
   * Pays and waits for Succeeded/Failed (/getpayment every 250 ms, timeout 30 s, SPEC §10.1).
   * Checks the invoice expiry first. Errors are WalletError with a shared ErrorCode
   * (INVOICE_EXPIRED, TOPUP_REQUIRED, NODE_UNREACHABLE, PAYMENT_FAILED, …).
   */
  pay(bolt11: string, opts?: { timeoutMs?: number }): Promise<PaymentProof>;
  balances(): Promise<WalletBalances>;
  /** dave only (SPEC §10.5). */
  openLiquidity(peerPubkey: string, cents: bigint): Promise<{ channelId: string }>;
  /** dave only: cooperative close of both channels with a member (SPEC §6.7). */
  closeChannelsWith(peerPubkey: string): Promise<{ txids: string[] }>;
  /**
   * rln-rest: lock → backup → unlock (SPEC §12). Returns the backup file, encrypted by the node
   * with its password: the agent uploads it to the relay, which cannot read it.
   */
  backupNow(): Promise<{ version: string; blob: Uint8Array }>;
}
