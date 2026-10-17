import {
  ActorIdSchema,
  isMemberId,
  type ActorId,
  type MemberId,
  type TripView,
} from '@kitty/shared';
import { Camera, QrCode, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  hashOf,
  openProof,
  proofParam,
  screenFromHash,
  swipeDirection,
  swipeTarget,
  type Screen,
} from './nav.js';
import { GroupSettingsScreen, GroupsScreen } from './screens/Groups.js';
import { HomeScreen } from './screens/Home.js';
import { NewExpenseScreen } from './screens/NewExpense.js';
import { ProfileScreen } from './screens/Profile.js';
import { DaveApp } from './screens/dave/DaveApp.js';
import { QrScreen } from './screens/Qr.js';
import { LogScreen } from './screens/shared/Log.js';
import { ProofScreen } from './screens/shared/Proof.js';
import { Styleguide } from './screens/Styleguide.js';
import type { ScreenProps } from './screens/types.js';
import { useTripState } from './state.js';
import { paymentToasts, type Toast } from './toasts.js';
import { TabBar, type TabItem } from './ui/Bars.js';
import { Mascot } from './ui/Mascot.js';
import { humanError } from './errors.js';
import { Banner, OperationsDock } from './ui/Notes.js';
import { StateView, Toasts } from './ui/Overlays.js';
import { Wordmark } from './ui/Text.js';

// The app, phone-sized: travelers (?as=alice|bob|charlie), the operator (?as=dave, DaveApp),
// and ?as=styleguide for the primitives.

const TOAST_MS = 3000;

function routeFromUrl(): ActorId | 'styleguide' | null {
  const as = new URLSearchParams(window.location.search).get('as');
  if (as === 'styleguide') return as;
  const r = ActorIdSchema.safeParse(as);
  return r.success ? r.data : null;
}

export function App() {
  const route = routeFromUrl();
  if (route === 'styleguide') return <Styleguide />;
  if (route === null) return <Picker />;
  if (!isMemberId(route)) return <DaveApp frame={(c) => <PhoneFrame>{c}</PhoneFrame>} />;
  return <Phone as={route} />;
}

function Picker() {
  return (
    <PhoneFrame>
      <div className="flex flex-col items-center gap-3 px-6 pt-20 text-center">
        <Mascot size={128} />
        <Wordmark size="large" />
        <p className="text-subhead text-label-2">Open the app as</p>
        <div className="flex gap-2">
          {ActorIdSchema.options.map((a) => (
            <a
              key={a}
              href={`?as=${a}`}
              className="pressable inline-flex min-h-11 items-center rounded-control bg-bg-fill px-4 text-headline font-semibold text-label"
            >
              {a}
            </a>
          ))}
        </div>
      </div>
    </PhoneFrame>
  );
}

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative mx-auto min-h-dvh max-w-[430px] bg-bg-grouped text-label">
      {children}
    </main>
  );
}

function useScreen(): [Screen, (s: Screen) => void] {
  const [screen, setScreen] = useState(() => screenFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setScreen(screenFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((s: Screen) => {
    const url = `${window.location.pathname}${window.location.search}${hashOf(s)}`;
    window.history.pushState(null, '', url);
    window.scrollTo(0, 0);
    setScreen(s);
  }, []);
  return [screen, go];
}

/** +ty / -ty from the difference between two polls, each shown for 3 s. */
function useToasts(state: TripView | null): Toast[] {
  const prev = useRef<TripView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    if (state === null) return;
    const fresh = paymentToasts(prev.current, state);
    prev.current = state;
    if (fresh.length === 0) return;
    setToasts((t) => [...t, ...fresh]);
    // Not cleared on the next poll (every second): each toast lives its own 3 s.
    const ids = new Set(fresh.map((t) => t.id));
    setTimeout(() => setToasts((t) => t.filter((x) => !ids.has(x.id))), TOAST_MS);
  }, [state]);
  return toasts;
}

const SCREEN_VIEWS: Record<Screen, (p: ScreenProps) => ReactNode> = {
  home: HomeScreen,
  new: NewExpenseScreen,
  qr: QrScreen,
  groups: GroupsScreen,
  group: GroupSettingsScreen,
  profile: ProfileScreen,
  log: ({ trip, go }) => (
    <LogScreen
      members={trip.state?.members ?? []}
      fakes={trip.state?.fakes ?? false}
      back={{ label: 'Profile', onClick: () => go('profile') }}
      onProof={openProof}
    />
  ),
  proof: ({ trip, go }) => {
    const hash = proofParam(window.location.hash);
    if (hash === null)
      return (
        <StateView
          kind="empty"
          title="No payment to prove"
          action={{ label: 'Back to Home', onClick: () => go('home') }}
        />
      );
    return (
      <ProofScreen
        client={trip.client}
        paymentHash={hash}
        back={{ label: 'Back', onClick: () => window.history.back() }}
      />
    );
  },
};

const TABS: readonly TabItem<'groups' | 'new' | 'qr'>[] = [
  { key: 'groups', label: 'Groups', icon: <Users size={22} strokeWidth={1.75} /> },
  { key: 'new', label: 'Expense', icon: <Camera size={22} strokeWidth={1.75} /> },
  { key: 'qr', label: 'QR', icon: <QrCode size={22} strokeWidth={1.75} /> },
];

const tabOf = (s: Screen) =>
  s === 'groups' || s === 'group' ? 'groups' : s === 'new' || s === 'qr' ? s : null;

function Phone({ as }: { as: MemberId }) {
  const trip = useTripState(as);
  const [screen, go] = useScreen();
  const toasts = useToasts(trip.state);
  const start = useRef<{ x: number; y: number } | null>(null);

  // Swipes between Home, New expense and QR; never while using a form control or a sheet.
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    start.current = target.closest('input, textarea, select, [data-noswipe]')
      ? null
      : { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    if (start.current === null) return;
    const dir = swipeDirection(e.clientX - start.current.x, e.clientY - start.current.y);
    start.current = null;
    const to = dir === null ? null : swipeTarget(screen, dir);
    if (to !== null) go(to);
  };

  const View = SCREEN_VIEWS[screen];
  const running = trip.state?.operations.filter((o) => o.status === 'running') ?? [];
  return (
    <PhoneFrame>
      <Toasts toasts={toasts} />
      <div
        className="min-h-dvh touch-pan-y pb-[calc(var(--tab-bar-space)+env(safe-area-inset-bottom))]"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (start.current = null)}
      >
        {trip.state?.fakes && <Banner>Fakes on · simulated wallet and AI, no real RGB</Banner>}
        {trip.reconnecting && trip.state !== null && (
          <Banner tone="quiet">Reconnecting to your agent…</Banner>
        )}
        {trip.state?.ledger.chainValid === false && (
          <Banner>
            The relay sent an entry this phone rejects. Your agent keeps its own copy.
          </Banner>
        )}
        {trip.state === null ? (
          trip.error === null ? (
            <StateView kind="loading" title="Waking up your agent…" />
          ) : (
            <StateView
              kind="error"
              title={humanError(trip.error).title}
              text={humanError(trip.error).action}
              action={{ label: 'Try again', onClick: trip.refresh }}
            />
          )
        ) : (
          <div key={window.location.hash || screen} className="animate-push">
            <View as={as} trip={trip} go={go} />
          </div>
        )}
      </div>
      <OperationsDock operations={running} />
      <TabBar items={TABS} active={tabOf(screen)} onSelect={go} />
    </PhoneFrame>
  );
}
