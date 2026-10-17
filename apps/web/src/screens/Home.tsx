import { DEFAULT_POLICY, formatCents } from '@kitty/shared';
import { useState, type ReactNode } from 'react';
import { Avatar, EmptyState, LimitBadge, Logo } from '../components.js';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { DemoSecondGroup, DEMO_SECOND_GROUP, GroupHistory } from './group-history.js';
import type { ScreenProps } from './types.js';

// Home (docs/DESIGN.md §6): avatar and logo on top, the Balance card of my trip channel, then
// each group as a card with its limit badge (tap: that group's slider) and its history; parts
// waiting for me come first, with a pink border.

export function HomeScreen(props: ScreenProps) {
  const { trip, as, go } = props;
  const s = trip.state;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const header =
    s?.trip == null ? (
      <h2 className="text-title">No trip yet</h2>
    ) : (
      <GroupHeader name={s.trip.name}>
        <LimitBadge
          limitCents={limit}
          channelCents={s.trip.params.tripChannelCents}
          onClick={() => go('group')}
        />
      </GroupHeader>
    );
  const history =
    s?.trip == null ? (
      <EmptyState>Waiting for dave to set up the trip.</EmptyState>
    ) : (
      <GroupHistory {...props} />
    );

  return (
    <div className="space-y-3 px-4 pt-4">
      <div className="flex items-center justify-between pb-1">
        <Avatar m={as} />
        <Logo onClick={() => go('profile')} />
      </div>
      <BalanceCard {...props} />
      {SHOW_DEMO_SECOND_GROUP ? (
        <>
          <section className="card">
            {header}
            <div className="mt-3">{history}</div>
          </section>
          <DemoSecondGroup
            header={
              <GroupHeader name={DEMO_SECOND_GROUP.name}>
                <span className="badge bg-line text-ink-muted">Limit</span>
              </GroupHeader>
            }
          />
        </>
      ) : (
        // One group: no card, the history runs to the bottom, behind the floating bar.
        <section className="pt-1">
          {header}
          <div className="mt-3">{history}</div>
        </section>
      )}
    </div>
  );
}

function GroupHeader({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="truncate text-title">{name}</h2>
      {children}
    </div>
  );
}

const hiddenKey = (as: string) => `kitty:${as}:hideBalance`;

function readHidden(as: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(as)) === '1';
  } catch {
    return false;
  }
}

function BalanceCard({ trip, as }: ScreenProps) {
  const [hidden, setHidden] = useState(() => readHidden(as));
  const toggle = () => {
    setHidden(!hidden);
    try {
      localStorage.setItem(hiddenKey(as), hidden ? '0' : '1');
    } catch {
      // Private window or blocked storage: the choice lasts until reload.
    }
  };
  const balance = trip.state?.me?.balance ?? null;

  return (
    <section className="card text-center">
      <p className="text-small font-semibold text-ink-muted">Balance</p>
      <p className="mt-1 font-slab text-big leading-tight font-bold tabular-nums">
        {balance === null ? '—' : hidden ? '•••••' : formatCents(balance.tripOutboundCents)}
        <span className="ml-2 font-sans text-body font-semibold text-ink-muted">DUSD</span>
      </p>
      <p className="text-small text-ink-muted">
        {balance === null
          ? 'Balance not available: your node is not responding.'
          : 'Only you can spend it'}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={hidden ? 'Show balance' : 'Hide balance'}
          aria-pressed={hidden}
          className="badge bg-plum-soft"
        >
          {hidden ? '🙈 Show' : '👁️ Hide'}
        </button>
      </div>
    </section>
  );
}
