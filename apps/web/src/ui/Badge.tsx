import type { ReactNode } from 'react';
import { paymentMode } from '../mode.js';

// Badges (DESIGN.md §7): Caption1 semibold pills.

export type BadgeKind =
  | 'auto'
  | 'limit'
  | 'ask'
  | 'active'
  | 'insolvent'
  | 'excluded'
  | 'left'
  | 'operator'
  | 'joining'
  | 'muted';

const KIND: Record<BadgeKind, string> = {
  auto: 'bg-positive text-on-positive',
  limit: 'bg-bg-fill text-label',
  ask: 'bg-bg-fill text-label',
  active: 'bg-positive-soft text-label',
  insolvent: 'bg-accent-soft text-label',
  excluded: 'bg-bg-fill text-label-2 line-through',
  left: 'bg-bg-fill text-label-2',
  operator: 'bg-bg-fill text-label',
  joining: 'bg-bg-fill text-label-2',
  muted: 'bg-bg-fill text-label-3',
};

const BASE = 'inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-caption font-semibold';

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return <span className={`${BASE} ${KIND[kind]}`}>{children}</span>;
}

/** The limit of a group: "Auto mode", "Limit 10.00", "Always ask"; a tap opens the slider. */
export function LimitBadge({
  limitCents,
  channelCents,
  onClick,
}: {
  limitCents: bigint;
  channelCents: bigint;
  onClick?: () => void;
}) {
  const mode = paymentMode(limitCents, channelCents);
  if (onClick === undefined) return <Badge kind={mode.kind}>{mode.badge}</Badge>;
  return (
    // 44×44 target around a 24px pill.
    <button
      type="button"
      onClick={onClick}
      aria-label={`${mode.long}. Change the limit`}
      className="pressable -my-2.5 flex min-h-11 items-center"
    >
      <span className={`${BASE} ${KIND[mode.kind]}`}>{mode.badge}</span>
    </button>
  );
}
