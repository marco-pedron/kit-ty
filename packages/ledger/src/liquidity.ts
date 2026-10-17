import type { Pubkey } from '@kitty/shared';
import type { LineRecord, LiquidityNeed, TripState } from './kitty.js';

// liquidityPlan (task A7, SPEC §10.5): dave's just-in-time liquidity. Seen from member m, the
// two channels with dave are one pool: what m can receive now is dave's side of them.

/** Moved m's channel balances: a Lightning payment by the debtor, or dave's guarantee. */
const overLightning = (l: LineRecord) =>
  l.payment !== null && (l.payment.by === 'guarantee' || l.payment.rail === 'ln');

/**
 * Per active member (channels ready, not excluded): inbound = L + extra + sent − received,
 * where L = params.liquidityCents, extra = liquidity dave opened after the first channel
 * (known to dave's node, not in the log), sent = lines m paid over Lightning, received = lines
 * in m's favour paid over Lightning or covered by the guarantee; on-chain payments leave the
 * channels alone. toReceive = open lines in m's favour (contested and overdue included: they
 * may still arrive); margin = inbound − toReceive; when margin < threshold, open
 * threshold − margin, so the margin is back at the threshold exactly.
 */
export function liquidityPlan(
  trip: TripState,
  thresholdCents: bigint,
  extraLiquidity: ReadonlyMap<Pubkey, bigint> = new Map(),
): LiquidityNeed[] {
  const lines = [...trip.lines.values()];
  return [...trip.members.values()]
    .filter((m) => m.channelsReady && !m.excluded)
    .map((m) => {
      let sent = 0n;
      let received = 0n;
      let toReceive = 0n;
      for (const l of lines) {
        if (l.debtorPubkey === m.pubkey && overLightning(l) && l.payment?.by === 'debtor')
          sent += l.cents;
        if (l.payerPubkey !== m.pubkey) continue;
        if (overLightning(l)) received += l.cents;
        else if (l.state !== 'paid' && l.state !== 'guaranteed' && l.state !== 'voided')
          toReceive += l.cents;
      }
      const inbound =
        trip.params.liquidityCents + (extraLiquidity.get(m.pubkey) ?? 0n) + sent - received;
      const margin = inbound - toReceive;
      return {
        memberPubkey: m.pubkey,
        inboundCents: inbound,
        toReceiveCents: toReceive,
        marginCents: margin,
        openCents: margin < thresholdCents ? thresholdCents - margin : 0n,
      };
    });
}
