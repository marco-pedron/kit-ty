import { formatCents, type AutoPayDecision, type DecodedInvoice, type Policy } from '@kitty/shared';
import type { LineRecord, TripState } from './kitty.js';

// decideAutoPay (task A3, SPEC §8): the "agentic dollars". Pure: the agent decodes the line
// invoice with its own node and passes it in; the reason is the sentence the debtor reads.

const DAY_MS = 24 * 60 * 60 * 1000;

/** "20 s", "5 min", "12 h": the silent-assent window in words. */
function duration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  const whole = (unit: number) => (seconds - (seconds % unit)) / unit;
  if (seconds < 7200) return `${whole(60)} min`;
  return `${whole(3600)} h`;
}

/** Σ paid automatically by this debtor in the rolling 24 h before `now`. */
export function autoPaidLast24h(trip: TripState, debtorPubkey: string, now: Date): bigint {
  const since = now.getTime() - DAY_MS;
  return (trip.autoPayments.get(debtorPubkey) ?? [])
    .filter((p) => p.at.getTime() > since && p.at.getTime() <= now.getTime())
    .reduce((a, p) => a + p.cents, 0n);
}

/**
 * Whether the debtor's agent pays this line now, and why. Pays only a `due` line (or an
 * `overdue` one the debtor approved explicitly: a late payment, SPEC §7) of an open trip whose
 * expense adds up, between members still in the trip, with an invoice (decoded by the debtor's
 * own node) payable to the creditor's registered node, for the trip asset and the line amount,
 * not expired. An upheld dispute is paid on its own only with payUpheldDisputes.
 * Automatic payments (no explicit approval) also stay within autoPayLimitCents, checked again in
 * case the policy changed after silent assent, and within dailyCapCents over a rolling 24 h; an
 * explicit approval pays regardless of both (SPEC §8). Every other state gets its sentence too,
 * for the UI (LineView.agent).
 */
export function decideAutoPay(
  policy: Policy,
  line: LineRecord,
  trip: TripState,
  now: Date,
  invoice: DecodedInvoice | null,
): AutoPayDecision {
  const no = (reason: string): AutoPayDecision => ({ pay: false, reason });
  const amount = formatCents(line.cents);
  const limit = formatCents(policy.autoPayLimitCents);
  const creditor = trip.members.get(line.payerPubkey);
  const debtor = trip.members.get(line.debtorPubkey);
  const to = creditor?.memberId ?? 'the payer';
  const automatic = !line.approvedExplicitly;
  const upheld = line.resolution === 'upheld';
  const assent = duration(trip.params.silentAssentSeconds);

  switch (line.state) {
    case 'paid': {
      if (line.payment?.by === 'debtor' && line.payment.rail === 'onchain')
        return no(`Paid ${amount} to ${to} on-chain.`);
      if (!automatic) return no(`Paid ${amount} to ${to}: you approved it.`);
      if (upheld) return no(`Paid ${amount} to ${to} automatically: dave upheld the expense.`);
      return no(
        `Paid ${amount} to ${to} automatically: no objection in ${assent}, under your limit of ${limit}.`,
      );
    }
    case 'guaranteed':
      return no(`The operator covered ${amount} to ${to}: you now owe it to the operator.`);
    case 'voided':
      return no(`Voided: you owe nothing for this line.`);
    case 'contested':
      return no(`You contested this line: waiting for dave to decide.`);
    case 'submitted':
      return no(`Not seen by your agent yet.`);
    case 'overdue':
      // Paying late is allowed (SPEC §7, overdue → paid), only once the debtor approved it.
      if (!automatic) break;
      if (upheld)
        return no(
          `Overdue: the payment deadline has passed. Approve ${amount} to pay ${to} now, or the operator will cover it.`,
        );
      return no(
        `Overdue: the payment deadline has passed. Pay ${amount} to ${to} yourself, or the operator will cover it.`,
      );
    case 'awaiting_explicit':
      return no(
        `Not paid: ${amount} is above your automatic limit of ${limit}. Approve it yourself.`,
      );
    case 'awaiting_decision': {
      if (line.cents > policy.autoPayLimitCents)
        return no(`Needs your approval: ${amount} is above your automatic limit of ${limit}.`);
      const left = (line.deadlineAt?.getTime() ?? now.getTime()) - now.getTime();
      const seconds = left > 0 ? (left - (left % 1000)) / 1000 : 0;
      return no(`Will pay ${amount} to ${to} in ${duration(seconds)} unless you object.`);
    }
    case 'due':
      break;
  }
  // From here: a due line, or an overdue line the debtor approved explicitly.

  if (trip.closed) return no(`The trip is closed: your agent pays nothing any more.`);
  if (debtor?.excluded) return no(`You were excluded: your channels are closed.`);
  if (creditor === undefined || creditor.excluded)
    return no(`${to} has left the trip: pay ${amount} on-chain.`);

  const expense = trip.expenses.get(line.expenseEventHash);
  if (expense === undefined || expense.voided) return no(`The expense is not verified.`);
  const b = expense.body;
  if (b.lines.reduce((a, l) => a + l.cents, 0n) + b.payerCents !== b.totalUsdCents)
    return no(`Not paid: the totals of this expense do not add up.`);

  if (upheld && automatic && !policy.payUpheldDisputes)
    return no(
      `Dave upheld ${to}'s expense: approve ${amount} yourself (your agent does not pay upheld disputes).`,
    );

  if (invoice === null) return no(`Not paid: your node could not read the invoice from ${to}.`);
  if (invoice.bolt11 !== line.bolt11)
    return no(`Not paid: the invoice is not the one signed in the log.`);
  if (invoice.payeePubkey !== creditor.nodePubkey)
    return no(`Not paid: the invoice is not payable to ${to}'s node.`);
  if (invoice.assetId !== trip.assetId || invoice.cents !== line.cents)
    return no(`Not paid: the invoice is not for ${amount} DUSD.`);
  if (Date.parse(invoice.expiresAt) <= now.getTime())
    return no(`The invoice from ${to} has expired: waiting for a new one.`);

  if (!automatic) return { pay: true, reason: `Paying ${amount} to ${to}: you approved it.` };

  if (line.cents > policy.autoPayLimitCents)
    return no(
      `Not paid: ${amount} is above your automatic limit of ${limit}. Approve it yourself.`,
    );
  const today = autoPaidLast24h(trip, line.debtorPubkey, now);
  if (today + line.cents > policy.dailyCapCents)
    return no(
      `Not paid: ${amount} more would exceed your daily cap of ${formatCents(policy.dailyCapCents)} (${formatCents(today)} paid automatically in the last 24 h). Approve it yourself.`,
    );

  if (upheld)
    return {
      pay: true,
      reason: `Paying ${amount} to ${to} automatically: dave upheld the expense and you let your agent pay upheld disputes.`,
    };
  return {
    pay: true,
    reason: `Paying ${amount} to ${to} automatically: no objection in ${assent}, under your limit of ${limit}.`,
  };
}
