import { formatCents, type LineView, type TripView } from '@kitty/shared';

// +ty / -ty (docs/DESIGN.md §1, §7): money that arrives is a thank-you, a debt settled is a
// closed bill. Found by comparing two polls of /state, so they show the moment the other window
// pays; nothing on the first poll.

export interface Toast {
  id: string;
  kind: 'plus' | 'minus';
  prefix: '+ty!' | '-ty!';
  text: string;
}

const name = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
const key = (l: LineView) => `${l.expenseId}:${l.debtor}`;
const settled = (l: LineView | undefined) => l?.state === 'paid' || l?.state === 'guaranteed';

export function paymentToasts(prev: TripView | null, next: TripView): Toast[] {
  if (prev?.me == null || next.me === null || prev.as !== next.as) return [];
  const before = new Map(
    [...prev.me.credits, ...prev.me.debts].map((l) => [key(l), l] as [string, LineView]),
  );
  const fresh = (l: LineView) => settled(l) && !settled(before.get(key(l)));
  const out: Toast[] = [];

  for (const l of next.me.credits.filter(fresh)) {
    const amount = `${formatCents(l.cents)} DUSD`;
    out.push({
      id: `plus:${key(l)}`,
      kind: 'plus',
      prefix: '+ty!',
      text:
        l.paidBy === 'guarantee'
          ? `${amount} from the operator, for ${name(l.debtor)}`
          : `${amount} from ${name(l.debtor)}`,
    });
  }
  for (const l of next.me.debts.filter((d) => fresh(d) && d.paidBy === 'debtor')) {
    out.push({
      id: `minus:${key(l)}`,
      kind: 'minus',
      prefix: '-ty!',
      text: `You settled ${formatCents(l.cents)} DUSD with ${name(l.payer)}`,
    });
  }
  return out;
}
