import {
  ActorIdSchema,
  isMemberId,
  type ActorId,
  type MemberId,
  type TripView,
} from '@kitty/shared';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Alert, ErrorBox, FakesBanner, Logo, Toasts } from './components.js';
import { Loading, Mascot } from './Mascot.js';
import { hashOf, screenFromHash, swipeDirection, swipeTarget, type Screen } from './nav.js';
import { GroupSettingsScreen, GroupsScreen } from './screens/Groups.js';
import { HomeScreen } from './screens/Home.js';
import { NewExpenseScreen } from './screens/NewExpense.js';
import { ProfileScreen } from './screens/Profile.js';
import { QrScreen } from './screens/Qr.js';
import type { ScreenProps } from './screens/types.js';
import { useNow, useTripState } from './state.js';
import { paymentToasts, type Toast } from './toasts.js';

// The traveler app in a phone-sized column (?as=alice|bob|charlie). Dave's screens are task C5.

const TOAST_MS = 3000;

function actorFromUrl(): ActorId | null {
  const r = ActorIdSchema.safeParse(new URLSearchParams(window.location.search).get('as'));
  return r.success ? r.data : null;
}

export function App() {
  const as = actorFromUrl();
  if (as === null) return <Picker />;
  if (!isMemberId(as))
    return (
      <PhoneFrame>
        <p className="p-6">
          This is the traveler app. Open it as alice, bob or charlie; dave&apos;s screens are coming
          soon.
        </p>
      </PhoneFrame>
    );
  return <Phone as={as} />;
}

function Picker() {
  return (
    <PhoneFrame>
      <div className="flex flex-col items-center gap-4 p-6 pt-16">
        <Mascot size={96} />
        <Logo />
        <p>Open as one of:</p>
        <ul className="flex gap-3">
          {ActorIdSchema.options.map((a) => (
            <li key={a}>
              <a href={`?as=${a}`} className="btn btn-secondary inline-block">
                {a}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </PhoneFrame>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-line">
      <main className="relative mx-auto min-h-dvh max-w-[420px] bg-bg text-ink">{children}</main>
    </div>
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
    setScreen(s);
  }, []);
  return [screen, go];
}

/** +ty / -ty from the difference between two polls, each shown for 3 s (§7). */
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
};

function Phone({ as }: { as: MemberId }) {
  const trip = useTripState(as);
  const [screen, go] = useScreen();
  const toasts = useToasts(trip.state);
  const start = useRef<{ x: number; y: number } | null>(null);

  // Swipes between Home, New expense and QR; never while using a form control.
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
        className="min-h-dvh touch-pan-y pb-24 select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (start.current = null)}
      >
        {trip.state?.fakes && <FakesBanner />}
        <div className="space-y-3 px-4 empty:hidden [&:not(:empty)]:pt-3">
          {trip.state?.ledger.chainValid === false && (
            <Alert title="The relay sent an entry this phone rejects.">
              Your agent stopped trusting it and keeps its own copy. Tell the coordinator.
            </Alert>
          )}
          {trip.error && <ErrorBox error={trip.error} />}
          {running.map((o) => (
            <Operation key={o.id} text={o.text} startedAt={o.startedAt} />
          ))}
        </div>
        {trip.state === null && trip.error === null ? (
          <Loading>Waking up your agent…</Loading>
        ) : (
          <View as={as} trip={trip} go={go} />
        )}
      </div>
      <BottomBar screen={screen} go={go} />
    </PhoneFrame>
  );
}

/** A long step of my agent (paying, signing…): the kitten waves while it runs. */
function Operation({ text, startedAt }: { text: string; startedAt: string }) {
  const now = useNow(500);
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return (
    <div role="status" className="card flex items-center gap-3 py-2">
      <Mascot size={40} />
      <p className="flex-1">{text}</p>
      <span className="text-small text-ink-muted tabular-nums">{s} s</span>
    </div>
  );
}

/** Floating plum pill, three round buttons of the same size (§6); the content scrolls behind. */
function BottomBar({ screen, go }: { screen: Screen; go: (s: Screen) => void }) {
  const items: { to: Screen; label: string; icon: string }[] = [
    { to: 'groups', label: 'Groups', icon: '🫂' },
    { to: 'new', label: 'New', icon: '📷' },
    { to: 'qr', label: 'QR', icon: '▦' },
  ];
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-4 z-20 mx-auto flex max-w-[420px] justify-center px-4">
      <div className="pointer-events-auto flex gap-3 rounded-full bg-plum p-2">
        {items.map(({ to, label, icon }) => (
          <button
            key={to}
            type="button"
            onClick={() => go(to)}
            aria-label={to === 'new' ? 'New expense' : label}
            aria-current={screen === to ? 'page' : undefined}
            className={`flex size-16 flex-col items-center justify-center gap-0.5 rounded-full text-small font-semibold ${screen === to ? 'bg-surface text-plum' : 'text-surface'}`}
          >
            <span className="text-title leading-none">{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
