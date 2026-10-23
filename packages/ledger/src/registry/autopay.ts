import { formatUnits, type DecodedInvoice } from '@kitty/shared';
import type { PolicyLimits } from '../conflicts.js';
import type { RegistryLine, RegistryTrip } from './derive.js';

// decideRegistryAutoPay (step 2): the agentic dollars on registry v2. The debtor's phone decodes
// the line invoice with its own node and passes it in. Pure.

const DAY_SECONDS = 24 * 60 * 60;

/** An amount of the trip asset as the user reads it ("3.09"). */
export function amountOf(trip: RegistryTrip, amount: bigint): string {
  return formatUnits(amount, trip.params.assetDecimals, trip.params.displayDecimals);
}

/**
 * D2, before any payment, automatic or by hand: the invoice is one issued for the line, payable
 * to the node the creditor bound with kitty-bind, for the trip asset and the amount signed, not
 * expired. Null when payable, otherwise why not; the app does not pay a line that fails it.
 */
export function invoiceRefusal(
  trip: RegistryTrip,
  line: RegistryLine,
  invoice: DecodedInvoice | null,
  now: number,
): string | null {
  const creditor = trip.members.get(line.payer);
  if (invoice === null) return 'your node could not read the invoice';
  if (!line.invoices.includes(invoice.bolt11)) return 'the invoice is not one issued for this line';
  if (creditor === undefined || invoice.payeePubkey !== creditor.nodePubkey)
    return `the invoice is not payable to ${creditor?.displayName ?? 'the payer'}'s node`;
  if (invoice.assetId !== trip.params.assetId) return 'the invoice is not for the trip asset';
  if (invoice.cents !== line.amount) return `the invoice is not for ${amountOf(trip, line.amount)}`;
  if (Date.parse(invoice.expiresAt) / 1000 <= now) return 'the invoice has expired';
  return null;
}

/** Σ paid automatically by this debtor in the 24 h before `now` (created_at of its payments). */
export function autoPaidLast24h(trip: RegistryTrip, debtor: string, now: number): bigint {
  return (trip.autoPayments.get(debtor) ?? [])
    .filter((p) => p.at > now - DAY_SECONDS && p.at <= now)
    .reduce((a, p) => a + p.amount, 0n);
}

export type RegistryAutoPay = { pay: boolean; reason: string };

/**
 * Pays only a `due` line with a payable invoice (D2). A line signed at the table or approved
 * counts as an explicit approval and is paid regardless of the limits; otherwise it must stay
 * within autoPayLimit and the 24 h dailyCap. D4 [22/10]: table shares are an explicit consent,
 * so they neither need room under the daily cap nor use it (deriveRegistry's autoPayments).
 */
export function decideRegistryAutoPay(
  policy: PolicyLimits,
  line: RegistryLine,
  trip: RegistryTrip,
  now: number,
  invoice: DecodedInvoice | null,
): RegistryAutoPay {
  const no = (reason: string): RegistryAutoPay => ({ pay: false, reason });
  const to = trip.members.get(line.payer)?.displayName ?? 'the payer';
  const show = (x: bigint) => amountOf(trip, x);
  const amount = show(line.amount);
  switch (line.state) {
    case 'paid':
      return no(`Paid ${amount} to ${to}.`);
    case 'voided':
      return no('Voided: you owe nothing for this line.');
    case 'contested':
      return no(
        'You contested this line: it is not paid automatically. You can still pay it by hand.',
      );
    case 'submitted':
      return no('Not seen by your phone yet.');
    case 'awaiting_decision':
      return no(`Will pay ${amount} to ${to} when the time to object ends, unless you object.`);
    case 'awaiting_explicit':
      return no(
        line.afterLeaving
          ? `This expense arrived after you left: approve it or contest it, nothing is paid automatically.`
          : line.afterExclusion
            ? `This expense arrived after an exclusion: approve it or contest it, nothing is paid automatically.`
            : `Not paid: ${amount} is above your automatic limit of ${show(policy.autoPayLimit)}. Approve it yourself.`,
      );
    case 'manual_only':
      return no(
        line.manualOnly === 'blocked'
          ? `${to} and you are blocked: pay ${amount} by hand.`
          : line.manualOnly === 'debtor_excluded'
            ? `You are excluded from the trip: pay ${amount} to ${to} by hand.`
            : `${to} is excluded from the trip: pay ${amount} by hand.`,
      );
    case 'due':
      break;
  }
  // [23/10] As a line upheld by dave in v1 (payUpheldDisputes off): the debtor contested it, so
  // the agent never pays it on its own; approving it is the debtor's explicit consent.
  if (line.group?.outcome === 'due' && !line.approvedExplicitly)
    return no(
      `The group decided you owe ${amount} to ${to}: approve it to let your agent pay, or pay it by hand.`,
    );
  const refusal = invoiceRefusal(trip, line, invoice, now);
  if (refusal !== null) return no(`Not paid: ${refusal}.`);
  if (line.approvedExplicitly)
    return {
      pay: true,
      reason: line.signedAtTable
        ? `Paying ${amount} to ${to}: you signed it at the table.`
        : `Paying ${amount} to ${to}: you approved it.`,
    };
  if (line.amount > policy.autoPayLimit)
    return no(`Not paid: ${amount} is above your automatic limit of ${show(policy.autoPayLimit)}.`);
  const today = autoPaidLast24h(trip, line.debtor, now);
  if (today + line.amount > policy.dailyCap)
    return no(
      `Not paid: ${amount} more would exceed your daily cap of ${show(policy.dailyCap)} (${show(today)} paid automatically in the last 24 h). Approve it yourself.`,
    );
  return {
    pay: true,
    reason: `Paying ${amount} to ${to} automatically: no objection in ${trip.params.silentAssentSeconds} s, under your limit of ${show(policy.autoPayLimit)}.`,
  };
}
