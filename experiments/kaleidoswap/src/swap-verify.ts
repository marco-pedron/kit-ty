// dave's mandatory checks before paying the traveler's HODL invoice in the atomic swap.
// Pure: every input is gathered beforehand (see gatherSwapFacts in swap.ts). If any check fails,
// dave does not pay.

/** BIP341 NUMS point (x-only): the HTLC has no key-path spend. */
export const NUMS_XONLY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
/** LDK HTLC_FAIL_BACK_BUFFER = 2 * MAX_BLOCKS_FOR_CONF + LATENCY_GRACE_PERIOD_BLOCKS = 39. */
export const HTLC_FAIL_BACK_BUFFER = 39;

/** What dave expects, from his own state: never from what the traveler says. */
export interface SwapExpectation {
  assetId: string;
  amount: number; // D, asset units
  travelerNodePubkey: string; // payee of the HODL invoice
  travelerRefundKey: string; // x-only, registered for this swap
  daveClaimKey: string; // x-only, dave's own
  timeout: number; // T, agreed absolute height
  minFinalCltvDelta: number; // accepted range of the invoice's min_final_cltv_expiry_delta (42..48)
  maxFinalCltvDelta: number;
  maxShadowCltv: number; // LDK's cap on the shadow CLTV offset: 3 * 144 = 432, whatever the graph
  marginBlocks: number; // blocks dave needs to confirm his claim after the latest reveal (72)
}

/** What dave observed: the invoice, the lock on-chain, his wallet's consignment validation. */
export interface SwapObservation {
  currentHeight: number;
  invoice: { paymentHash: string; assetId: string | null; assetAmount: number | null; payeePubkey: string; minFinalCltvExpiryDelta: number; expiresAt: number };
  /** The terms the traveler announced (checked one by one, for readable reasons). */
  announced: { hash: string; claim: string; refund: string; timeout: number };
  /** The HTLC dave computes himself from (invoice hash, his key, the traveler's key, T). */
  expected: { scriptPubkey: string; internalKey: string };
  /** The lock output as seen in the confirmed lock transaction (null if not found). */
  lockOutput: { scriptPubkey: string; valueSat: number; confirmations: number } | null;
  /** dave's rgb-lib wallet accepted and validated the lock consignment for (asset, amount). */
  consignment: { accepted: true; assetId: string; amount: number } | { accepted: false; error: string };
  nowSec: number;
}

export interface SwapVerdict {
  pay: boolean;
  failures: string[];
  /** Worst-case cltv_expiry of the held HTLC: the traveler can reveal P before this height. */
  lnDeadlineBound: number;
}

/** Worst case of the held HTLC's cltv_expiry if dave pays at `height`: LDK sets it to
 *  height + 1 + final delta + shadow offset (≤ 432). The traveler's claim deadline is 39 blocks
 *  earlier (HTLC_FAIL_BACK_BUFFER); the bound ignores that, on the safe side. */
export function lnDeadlineBound(height: number, finalCltvDelta: number, maxShadowCltv: number): number {
  return height + 1 + finalCltvDelta + maxShadowCltv;
}

export function verifySwap(x: SwapExpectation, o: SwapObservation): SwapVerdict {
  const f: string[] = [];
  const delta = o.invoice.minFinalCltvExpiryDelta;
  const deadline = lnDeadlineBound(o.currentHeight, delta, x.maxShadowCltv);
  const H = o.invoice.paymentHash;

  // on-chain: confirmed, not just in mempool, and exactly the script dave computed
  if (!o.lockOutput) f.push('lock output not found in a transaction');
  else {
    if (o.lockOutput.confirmations < 1) f.push(`lock not confirmed (${o.lockOutput.confirmations} confirmations)`);
    if (o.lockOutput.scriptPubkey !== o.expected.scriptPubkey) f.push('lock script differs from the expected HTLC script');
    if (o.lockOutput.valueSat < 546) f.push(`lock output carries ${o.lockOutput.valueSat} sat, below dust`);
  }
  if (o.expected.internalKey !== NUMS_XONLY) f.push('expected HTLC internal key is not NUMS');

  // RGB: dave's wallet validated the consignment for this asset and amount
  if (!o.consignment.accepted) f.push(`consignment not accepted: ${o.consignment.error}`);
  else {
    if (o.consignment.assetId !== x.assetId) f.push(`consignment asset ${o.consignment.assetId} ≠ ${x.assetId}`);
    if (o.consignment.amount !== x.amount) f.push(`consignment amount ${o.consignment.amount} ≠ D ${x.amount}`);
  }

  // the HODL invoice
  if (o.invoice.assetId !== x.assetId) f.push(`invoice asset ${o.invoice.assetId} ≠ ${x.assetId}`);
  if (o.invoice.assetAmount !== x.amount) f.push(`invoice amount ${o.invoice.assetAmount} ≠ D ${x.amount}`);
  if (o.invoice.payeePubkey !== x.travelerNodePubkey) f.push('invoice payee is not the traveler node');
  if (!(delta >= x.minFinalCltvDelta && delta <= x.maxFinalCltvDelta))
    f.push(`invoice final CLTV delta ${delta} outside ${x.minFinalCltvDelta}..${x.maxFinalCltvDelta}`);
  if (o.invoice.expiresAt <= o.nowSec) f.push('invoice expired');

  // the announced terms, one by one
  if (o.announced.hash !== H) f.push('HTLC hash ≠ invoice payment hash');
  if (o.announced.claim !== x.daveClaimKey) f.push('HTLC claim key is not dave');
  if (o.announced.refund !== x.travelerRefundKey) f.push('HTLC refund key is not the traveler');
  if (o.announced.timeout !== x.timeout) f.push(`HTLC timeout ${o.announced.timeout} ≠ agreed T ${x.timeout}`);

  // timing: the traveler's latest possible reveal leaves dave marginBlocks to confirm his claim
  if (x.timeout < deadline + x.marginBlocks)
    f.push(`T too close: T ${x.timeout} < worst-case LN expiry ${deadline} + ${x.marginBlocks}`);

  return { pay: f.length === 0, failures: f, lnDeadlineBound: deadline };
}
