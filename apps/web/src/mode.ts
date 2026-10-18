import { formatCents } from '@kitty/shared';

// The payment mode of a traveler's agent in one group, from the one limit slider (PM decision,
// FLOWS.md §B): 0 = the agent never pays on its own; the trip channel capacity D = it pays every
// part after the dispute window; in between = it pays parts up to the limit. `badge` is the pill
// shown next to the group (Home, Groups); `long` is the slider's label.

export type PaymentMode =
  | { kind: 'ask'; badge: string; long: string }
  | { kind: 'limit'; badge: string; long: string }
  | { kind: 'auto'; badge: string; long: string };

export function paymentMode(limitCents: bigint, channelCents: bigint): PaymentMode {
  if (limitCents <= 0n) return { kind: 'ask', badge: 'Always ask', long: 'Always ask me' };
  if (limitCents >= channelCents)
    return { kind: 'auto', badge: 'Auto mode', long: 'Automatic payment' };
  const x = formatCents(limitCents);
  return { kind: 'limit', badge: `Limit ${x} DUSD`, long: `Pay automatically up to ${x} DUSD` };
}
