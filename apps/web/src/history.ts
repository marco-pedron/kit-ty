import { formatCents, type ExpenseView, type LineView, type MemberId } from '@kitty/shared';
import { formatCountdown } from './lines.js';

// The history of a group as the wireframe draws it, seen by one member: what I paid ("Taxi · you
// paid", who still owes), what arrived ("Bob paid you", +ty), what I paid others ("Dinner ·
// Charlie paid", -ty). Parts waiting for me are not here: they are the approval cards on top.

export interface HistoryRow {
  key: string;
  /** Whose initial is in the avatar. */
  name: string;
  me: boolean;
  title: string;
  subtitle: string;
  cents: bigint;
  sign: '+' | '-' | null;
  at: string;
  muted: boolean;
  /** Payment hash or txid of the payment this row shows, for the Proof screen. */
  proof: string | null;
  /** The payer waits for the debtors' agents: since when (the kitten and the time elapsed). */
  waitingSince: string | null;
}

export const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
const SETTLED = (l: LineView) => l.state === 'paid' || l.state === 'guaranteed';
const proofOf = (l: LineView | undefined) =>
  l?.proof == null ? null : l.proof.rail === 'ln' ? l.proof.paymentHash : l.proof.txid;
const OPEN = (l: LineView) => !SETTLED(l) && l.state !== 'voided';
const UNDECIDED = (l: LineView) =>
  l.state === 'submitted' || l.state === 'awaiting_decision' || l.state === 'awaiting_explicit';

function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "Bob and Charlie owe 17.44", or each amount when they differ. */
function stillOwed(open: readonly LineView[]): string {
  const first = open[0];
  if (first === undefined) return 'all settled';
  if (open.every((l) => l.cents === first.cents)) {
    const who = names(open.map((l) => cap(l.debtor)));
    return `${who} ${open.length === 1 ? 'owes' : 'owe'} ${formatCents(first.cents)}`;
  }
  return open.map((l) => `${cap(l.debtor)} owes ${formatCents(l.cents)}`).join(', ');
}

function myPartSubtitle(l: LineView): string {
  switch (l.state) {
    case 'paid':
      return l.agent?.reason.includes('approved')
        ? '-ty · you approved'
        : '-ty · paid automatically';
    case 'guaranteed':
      return 'covered by the operator';
    case 'voided':
      return 'voided';
    case 'contested':
      return 'disputed · Dave will decide';
    case 'overdue':
      return 'overdue';
    case 'due':
      return 'paying…';
    default:
      return 'waiting';
  }
}

export function historyRows(
  expenses: readonly ExpenseView[],
  me: MemberId,
  pending: (l: LineView) => boolean,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const e of expenses) {
    const base = { at: e.submittedAt };
    if (e.payer === me) {
      for (const l of e.lines.filter(SETTLED))
        rows.push({
          ...base,
          key: `${e.expenseId}:${l.debtor}:in`,
          name: l.debtor,
          me: false,
          title:
            l.paidBy === 'guarantee'
              ? `Operator paid for ${cap(l.debtor)}`
              : `${cap(l.debtor)} paid you`,
          subtitle: `+ty · ${e.merchant}`,
          cents: l.cents,
          sign: '+',
          muted: false,
          proof: proofOf(l),
          waitingSince: null,
        });
      const undecided = e.status === 'voided' ? [] : e.lines.filter(UNDECIDED);
      rows.push({
        ...base,
        key: e.expenseId,
        name: me,
        me: true,
        title: e.merchant,
        subtitle:
          undecided.length > 0
            ? `You paid · Waiting for ${names(undecided.map((l) => cap(l.debtor)))}…`
            : `You paid · ${e.status === 'voided' ? 'voided' : stillOwed(e.lines.filter(OPEN))}`,
        cents: e.totalUsdCents,
        sign: null,
        muted: e.status === 'voided',
        proof: null,
        waitingSince: undecided.length > 0 ? e.submittedAt : null,
      });
      continue;
    }
    const mine = e.lines.find((l) => l.debtor === me);
    if (mine !== undefined && pending(mine)) continue;
    rows.push({
      ...base,
      key: e.expenseId,
      name: e.payer,
      me: false,
      title: e.merchant,
      subtitle: `${cap(e.payer)} paid · ${mine === undefined ? 'you are not in this one' : myPartSubtitle(mine)}`,
      cents: mine?.cents ?? e.totalUsdCents,
      sign: mine === undefined || mine.state === 'voided' ? null : '-',
      muted: mine?.state === 'voided' || e.status === 'voided',
      proof: proofOf(mine),
      waitingSince: null,
    });
  }
  return rows;
}

/** The approval card's title and the agent's sentence, in the wireframe's words. */
export function approvalText(
  l: LineView,
  merchant: string,
  limitCents: bigint,
  secondsLeft: number | null,
): { title: string; sentence: string } {
  // The amount first: on a narrow screen the merchant is what gets cut.
  const title = `${cap(l.payer)} paid · ${formatCents(l.cents)} · ${merchant}`;
  const askAlways = limitCents <= 0n;
  let sentence: string;
  if (l.resolution?.outcome === 'upheld') sentence = 'Dave upheld it: I need your OK';
  else if (l.state === 'submitted') sentence = 'Your agent is checking it…';
  else if (l.state === 'awaiting_decision' && l.cents <= limitCents)
    sentence = `Paying in ${formatCountdown(secondsLeft ?? 0)} unless you dispute`;
  else if (askAlways) sentence = 'You asked me to always ask: I need your OK';
  else sentence = `Above your limit of ${formatCents(limitCents)}: I need your OK`;
  return { title, sentence };
}
