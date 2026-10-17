import { DEFAULT_POLICY, formatCents } from '@kitty/shared';
import { useState, type ReactNode } from 'react';
import { EmptyState, LimitBadge, Logo } from '../components.js';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { DemoSecondGroup, DEMO_SECOND_GROUP, GroupHistory } from './group-history.js';
import type { ScreenProps } from './types.js';

// Home (PM prototype and fintech reference): the Balance card of my trip channel, then each
// group as a card with its limit badge and its history; parts waiting for me come first.
// Tapping the badge opens that group's limit slider.

export function HomeScreen(props: ScreenProps) {
  const { trip, go } = props;
  const s = trip.state;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const header =
    s?.trip == null ? (
      <h2 className="text-lg font-semibold">No trip yet</h2>
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
    <div className="space-y-4 px-4 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-lg font-semibold">kit+ty</p>
        <Logo onClick={() => go('profile')} />
      </div>
      <BalanceCard {...props} />
      {SHOW_DEMO_SECOND_GROUP ? (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            {header}
            <div className="mt-2">{history}</div>
          </section>
          <DemoSecondGroup
            header={
              <GroupHeader name={DEMO_SECOND_GROUP.name}>
                <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-semibold">
                  Limit
                </span>
              </GroupHeader>
            }
          />
        </>
      ) : (
        // One group: no card, the history runs to the bottom, behind the floating bar.
        <section>
          {header}
          <div className="mt-2">{history}</div>
        </section>
      )}
    </div>
  );
}

function GroupHeader({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="truncate text-lg font-semibold">{name}</h2>
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
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">Balance</p>
        <button
          type="button"
          onClick={toggle}
          aria-label={hidden ? 'Show balance' : 'Hide balance'}
          aria-pressed={hidden}
          className="rounded-full bg-gray-100 px-3 py-1 text-sm"
        >
          {hidden ? '🙈' : '👁️'}
        </button>
      </div>
      <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
        {balance === null ? '—' : hidden ? '•••••' : formatCents(balance.tripOutboundCents)}
        <span className="ml-2 text-base font-medium text-gray-500">DUSD</span>
      </p>
      <p className="mt-1 text-xs text-gray-500">
        {balance === null
          ? 'Balance not available: your node is not responding.'
          : 'In your trip channel. Only you can spend it.'}
      </p>
    </section>
  );
}
