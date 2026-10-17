import {
  formatCents,
  type ApiClientError,
  type DefaultView,
  type DisputeView,
  type TripView,
} from '@kitty/shared';
import { House, ScrollText, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  ago,
  daveHash,
  daveRouteFromHash,
  daveSwipe,
  guaranteeLeft,
  type DaveRoute,
} from '../../dave.js';
import { useNow, useTripState, toClientError, type TripState } from '../../state.js';
import { TabBar, type TabItem } from '../../ui/Bars.js';
import { Banner, ErrorNote } from '../../ui/Notes.js';
import { StateView } from '../../ui/Overlays.js';
import { CoverScreen } from './Cover.js';
import { DaveHome } from './Home.js';
import { DisputeScreen } from './Dispute.js';
import { DaveLog, MembersScreen, DaveProfile } from './Others.js';

// Dave's app (wireframe-dave.pdf, task C5): Home with disputes, insolvencies and the rate of the
// day; Members on the left, Log on the right; the bar Members · Home · Log. "Cover and exclude"
// runs for about a minute on the real nodes: the request lives here, so Dave can leave its screen
// and come back to it.

export interface CoverJob {
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  error: ApiClientError | null;
}

export interface DaveProps {
  trip: TripState;
  state: TripView;
  go: (r: DaveRoute) => void;
  covers: ReadonlyMap<string, CoverJob>;
  startCover: (d: Pick<DefaultView, 'expenseId' | 'debtor'>) => void;
}

export const lineKey = (expenseId: string, member: string) => `${expenseId}:${member}`;

function useRoute(): [DaveRoute, (r: DaveRoute) => void] {
  const [route, setRoute] = useState(() => daveRouteFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(daveRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: DaveRoute) => {
    window.history.pushState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${daveHash(r)}`,
    );
    window.scrollTo(0, 0);
    setRoute(r);
  }, []);
  return [route, go];
}

const TABS: readonly TabItem<'members' | 'home' | 'log'>[] = [
  { key: 'members', label: 'Members', icon: <Users size={22} strokeWidth={1.75} /> },
  { key: 'home', label: 'Home', icon: <House size={22} strokeWidth={1.75} /> },
  { key: 'log', label: 'Log', icon: <ScrollText size={22} strokeWidth={1.75} /> },
];

export function DaveApp({ frame }: { frame: (children: ReactNode) => ReactNode }) {
  const trip = useTripState('dave');
  const [route, go] = useRoute();
  const [covers, setCovers] = useState<Map<string, CoverJob>>(new Map());
  const start = useRef<{ x: number; y: number } | null>(null);

  const startCover = useCallback(
    (d: Pick<DefaultView, 'expenseId' | 'debtor'>) => {
      const key = lineKey(d.expenseId, d.debtor);
      const set = (job: CoverJob) => setCovers((m) => new Map(m).set(key, job));
      const startedAt = Date.now();
      set({ startedAt, status: 'running', error: null });
      trip.client
        .coverAndExclude({ expenseId: d.expenseId, member: d.debtor })
        .then(() => set({ startedAt, status: 'done', error: null }))
        .catch((e: unknown) => set({ startedAt, status: 'failed', error: toClientError(e) }))
        .finally(trip.refresh);
    },
    [trip],
  );

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    start.current = t.closest('input, textarea, select, [data-noswipe]')
      ? null
      : { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    if (start.current === null) return;
    const to = daveSwipe(route.name, e.clientX - start.current.x, e.clientY - start.current.y);
    start.current = null;
    if (to !== null) go(to);
  };

  const s = trip.state;
  const tab =
    route.name === 'members' || route.name === 'log'
      ? route.name
      : route.name === 'home'
        ? 'home'
        : null;
  return frame(
    <>
      <div
        className="min-h-dvh touch-pan-y pb-[calc(var(--tab-bar-space)+env(safe-area-inset-bottom))]"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (start.current = null)}
      >
        {s?.fakes && <Banner>Fakes on · simulated wallet and AI, no real RGB</Banner>}
        {s === null ? (
          trip.error === null ? (
            <StateView kind="loading" title="Waking up the operator's agent…" />
          ) : (
            <StateView
              kind="error"
              title={trip.error.message}
              text={trip.error.action}
              action={{ label: 'Try again', onClick: trip.refresh }}
            />
          )
        ) : (
          <div key={daveHash(route)} className="animate-push">
            <Route route={route} props={{ trip, state: s, go, covers, startCover }} />
          </div>
        )}
        {s !== null && trip.error !== null && (
          <div className="px-4 pt-4">
            <ErrorNote error={trip.error} onRetry={trip.refresh} />
          </div>
        )}
      </div>
      <TabBar items={TABS} active={tab} onSelect={(k) => go({ name: k })} />
    </>,
  );
}

function Route({ route, props }: { route: DaveRoute; props: DaveProps }) {
  switch (route.name) {
    case 'home':
      return <DaveHome {...props} />;
    case 'members':
      return <MembersScreen {...props} />;
    case 'log':
      return <DaveLog {...props} />;
    case 'profile':
      return <DaveProfile {...props} />;
    case 'dispute':
      return <DisputeScreen {...props} expenseId={route.expenseId} member={route.member} />;
    case 'cover':
      return <CoverScreen {...props} expenseId={route.expenseId} member={route.member} />;
  }
}

/** "opened 0:42 ago", ticking. */
export function Ago({ iso, prefix }: { iso: string; prefix: string }) {
  const now = useNow(1000);
  return (
    <span>
      {prefix} {ago(iso, now)}
    </span>
  );
}

export const findDispute = (
  s: TripView,
  expenseId: string,
  member: string,
): DisputeView | undefined =>
  s.coordinator?.disputes.find((d) => d.expenseId === expenseId && d.debtor === member);

export const totalGuarantee = (s: TripView) => formatCents(guaranteeLeft(s));
