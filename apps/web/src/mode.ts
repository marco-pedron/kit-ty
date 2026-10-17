import { formatCents } from '@kitty/shared';

// The payment mode of a traveler's agent, from the one limit slider (PM decision, FLOWS.md §B):
// 0 = the agent never pays on its own; the trip channel capacity D = it pays every part after
// the dispute window; in between = it pays parts up to the limit.

export type PaymentMode =
  | { kind: 'ask'; short: string; long: string }
  | { kind: 'limit'; short: string; long: string }
  | { kind: 'auto'; short: string; long: string };

export function paymentMode(limitCents: bigint, channelCents: bigint): PaymentMode {
  if (limitCents <= 0n) return { kind: 'ask', short: 'Always ask me', long: 'Always ask me' };
  if (limitCents >= channelCents)
    return { kind: 'auto', short: 'Automatic payment', long: 'Automatic payment' };
  const x = formatCents(limitCents);
  return { kind: 'limit', short: `Limit ${x}`, long: `Pay automatically up to ${x} DUSD` };
}
