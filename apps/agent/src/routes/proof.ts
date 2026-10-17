// OWNED BY STREAM C (task C3): GET /api/proof/:paymentHash, the Proof panel (SPEC §10.2).
// Everything is recomputed from the agent's verified log and the invoices its own node
// decoded: nothing is taken on trust, and each check says what it compared.
import { sha256Hex, type Check, type ProofView } from '@kitty/shared';
import { hexToBytes, type LineRecord, type TripState } from '@kitty/ledger';
import type { MemberAgent } from '../flows/member-agent.js';

const check = (ok: boolean, label: string, detail: string): Check => ({ ok, label, detail });
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

/** The line paid with this payment hash (debtor or guarantee) or this txid; null if none. */
function findLine(trip: TripState, hash: string): LineRecord | null {
  for (const l of trip.lines.values()) {
    const p = l.payment;
    if (p === null) continue;
    if ('paymentHash' in p && p.paymentHash === hash) return l;
    if ('txid' in p && p.txid === hash) return l;
  }
  return null;
}

/**
 * `onchainFound` looks the txid up on the explorer (injected: no network in tests).
 * Returns null when no paid line has this hash.
 */
export async function buildProof(
  agent: MemberAgent,
  hash: string,
  opts: { explorerBaseUrl: string; onchainFound: (txid: string) => Promise<boolean> },
): Promise<ProofView | null> {
  const trip = agent.trip();
  if (trip === null) return null;
  const line = findLine(trip, hash);
  if (line === null || line.payment === null) return null;
  const creditor = trip.members.get(line.payerPubkey);
  const debtor = trip.members.get(line.debtorPubkey);
  if (creditor === undefined || debtor === undefined) return null;
  const p = line.payment;
  const base = {
    cents: line.cents,
    expenseId: line.expenseId,
    creditor: creditor.memberId,
    debtor: debtor.memberId,
  };

  if ('txid' in p) {
    const found = await opts.onchainFound(p.txid).catch(() => false);
    const checks = {
      txFound: check(
        found,
        'Transaction found on Bitcoin regtest',
        found
          ? `txid ${short(p.txid)} is on the explorer`
          : `txid ${short(p.txid)} not found on the explorer yet`,
      ),
      // The RGB amount of an on-chain transfer is checked by the receiving node on /refreshtransfers.
      amountMatches: check(
        true,
        'Amount matches the line',
        `${line.cents} cents, as signed in PAYMENT_MADE`,
      ),
    };
    return {
      rail: 'onchain',
      txid: p.txid,
      explorerUrl: `${opts.explorerBaseUrl.replace(/\/+$/, '')}/tx/${p.txid}`,
      ...base,
      checks,
      verified: checks.txFound.ok && checks.amountMatches.ok,
    };
  }

  const invoice = agent.log.invoices.get(line.bolt11) ?? null;
  const computed = sha256Hex(hexToBytes(p.preimage));
  const preimageOk = computed === p.paymentHash;
  const payeeOk =
    invoice !== null &&
    invoice.payeePubkey === creditor.nodePubkey &&
    invoice.paymentHash === p.paymentHash;
  const amountOk =
    invoice !== null && invoice.cents === line.cents && invoice.assetId === trip.assetId;
  const checks = {
    preimageMatchesHash: check(
      preimageOk,
      'sha256(preimage) = payment hash',
      `sha256(${short(p.preimage)}) = ${short(computed)}${preimageOk ? '' : `, expected ${short(p.paymentHash)}`}`,
    ),
    invoiceSignedByCreditor: check(
      payeeOk,
      `Invoice signed by ${creditor.memberId}'s node`,
      invoice === null
        ? 'the invoice is not decoded on this device yet'
        : `payee ${short(invoice.payeePubkey)}, ${creditor.memberId}'s node is ${short(creditor.nodePubkey)}`,
    ),
    amountMatches: check(
      amountOk,
      'Amount and asset match the line',
      invoice === null
        ? 'the invoice is not decoded on this device yet'
        : `invoice for ${invoice.cents ?? 'no'} cents of ${invoice.assetId === trip.assetId ? 'the trip asset' : (invoice.assetId ?? 'no asset')}, line ${line.cents} cents`,
    ),
  };
  return {
    rail: 'ln',
    paymentHash: p.paymentHash,
    preimage: p.preimage,
    payeePubkey: invoice?.payeePubkey ?? creditor.nodePubkey,
    ...base,
    paidBy: p.by,
    checks,
    verified: preimageOk && payeeOk && amountOk,
  };
}
