import { DEFAULT_POLICY, formatCents } from '@kitty/shared';
import { useState } from 'react';
import { EmptyState, Logo } from '../components.js';
import { paymentMode } from '../mode.js';
import type { ScreenProps } from './types.js';

// Home (PM prototype): balance of my trip channel and payment mode on top, the logo to the
// profile, then the group with its expenses and my parts (C4b).

export function HomeScreen(props: ScreenProps) {
  const { trip } = props;
  return (
    <>
      <TopBar {...props} />
      <section className="px-4 pt-4">
        <h2 className="text-lg font-semibold">{trip.state?.trip?.name ?? 'No trip yet'}</h2>
        <EmptyState>
          {trip.state?.trip
            ? 'No expenses yet. When someone pays for the group, it shows here.'
            : 'Waiting for dave to set up the trip.'}
        </EmptyState>
      </section>
    </>
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

function TopBar({ trip, as, go }: ScreenProps) {
  const [hidden, setHidden] = useState(() => readHidden(as));
  const toggle = () => {
    setHidden(!hidden);
    try {
      localStorage.setItem(hiddenKey(as), hidden ? '0' : '1');
    } catch {
      // Private window or blocked storage: the choice lasts until reload.
    }
  };
  const s = trip.state;
  const balance = s?.me?.balance ?? null;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const mode = s?.trip ? paymentMode(limit, s.trip.params.tripChannelCents) : null;

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur">
      <div>
        <div className="flex items-center gap-2">
          <span
            className="rounded-lg border border-gray-300 px-2 py-0.5 text-lg font-semibold tabular-nums"
            title={
              balance === null
                ? 'Balance not available: your node is not responding'
                : 'Only you can spend it'
            }
          >
            {balance === null ? '—' : hidden ? '•••••' : formatCents(balance.tripOutboundCents)}
            <span className="ml-1 text-xs font-medium text-gray-500">DUSD</span>
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label={hidden ? 'Show balance' : 'Hide balance'}
            aria-pressed={hidden}
            className="text-lg"
          >
            {hidden ? '🙈' : '👁️'}
          </button>
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{mode?.short ?? ' '}</p>
      </div>
      <Logo onClick={() => go('profile')} />
    </header>
  );
}
