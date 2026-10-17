import {
  formatCents,
  isMemberId,
  type ExpenseView,
  type MemberId,
  type TripView,
} from '@kitty/shared';
import { SWIPE_MIN_PX } from './config.js';
import { swipeDirection } from './nav.js';

// Dave's app (wireframe-dave.pdf): routes in the URL hash, swipes (left = Members, right = Log),
// and the pure helpers his screens need. The operator never sees a traveler's balance (SPEC §1):
// the money he sees is the guarantee.

export type DaveRoute =
  | { name: 'home' | 'members' | 'log' | 'profile' }
  | { name: 'dispute' | 'cover'; expenseId: string; member: MemberId }
  | { name: 'proof'; paymentHash: string };

export function daveRouteFromHash(hash: string): DaveRoute {
  const [name, expenseId, member] = hash.replace(/^#\/?/, '').split('/');
  if ((name === 'dispute' || name === 'cover') && expenseId && member && isMemberId(member))
    return { name, expenseId, member };
  if (name === 'proof' && expenseId !== undefined && /^[0-9a-f]{64}$/.test(expenseId))
    return { name, paymentHash: expenseId };
  if (name === 'members' || name === 'log' || name === 'profile') return { name };
  return { name: 'home' };
}

export function daveHash(r: DaveRoute): string {
  if (r.name === 'home') return '';
  if (r.name === 'dispute' || r.name === 'cover') return `#/${r.name}/${r.expenseId}/${r.member}`;
  if (r.name === 'proof') return `#/proof/${r.paymentHash}`;
  return `#/${r.name}`;
}

/** Home ← swipe → Members (finger to the left) / Log (to the right), and back. */
export function daveSwipe(from: DaveRoute['name'], dx: number, dy: number): DaveRoute | null {
  const dir = swipeDirection(dx, dy, SWIPE_MIN_PX);
  if (dir === null) return null;
  if (from === 'home') return { name: dir === 'left' ? 'members' : 'log' };
  if (from === 'members' && dir === 'right') return { name: 'home' };
  if (from === 'log' && dir === 'left') return { name: 'home' };
  return null;
}

/** "0:42 ago", "2 min ago", "1 h ago". */
export function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `0:${String(s).padStart(2, '0')} ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** The guarantee the operator still has for the trip: Σ G − used, over every member. */
export function guaranteeLeft(state: TripView): bigint {
  return (state.coordinator?.members ?? []).reduce((a, m) => a + m.guaranteeLeftCents, 0n);
}

/** A rate the coordinator types: a positive decimal string, as RATE_SET expects. */
export function parseRate(input: string): string | null {
  const v = input.trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(v) && !/^0+(\.0+)?$/.test(v) ? v : null;
}

/** "1 DUSD = 0.86 EUR": rates are units of a currency per 1 USD, and 1 DUSD = 1 USD. */
export const rateLine = (currency: string, rate: string) => `1 DUSD = ${rate} ${currency}`;

/** "Alice 3.09 · Bob 3.09 · Charlie 3.50": who pays what of an expense, payer included. */
export function splitOf(e: ExpenseView): { member: string; cents: bigint }[] {
  return [
    { member: e.payer, cents: e.payerCents },
    ...e.lines.map((l) => ({ member: l.debtor, cents: l.cents })),
  ];
}

export const money = (c: bigint) => formatCents(c);
