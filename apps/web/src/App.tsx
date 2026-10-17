import { ActorIdSchema, isMemberId, type ActorId, type MemberId } from '@kitty/shared';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ErrorBox, FakesBanner } from './components.js';
import { hashOf, screenFromHash, swipeDirection, swipeTarget, type Screen } from './nav.js';
import { GroupSettingsScreen, GroupsScreen } from './screens/Groups.js';
import { HomeScreen } from './screens/Home.js';
import { NewExpenseScreen } from './screens/NewExpense.js';
import { ProfileScreen } from './screens/Profile.js';
import { QrScreen } from './screens/Qr.js';
import type { ScreenProps } from './screens/types.js';
import { useTripState } from './state.js';

// The traveler app in a phone-sized column (?as=alice|bob|charlie). Dave's screens are task C5.

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
        <p className="p-6 text-sm">
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
      <div className="p-6">
        <h1 className="text-xl font-semibold">kit+ty</h1>
        <p className="mt-2 text-sm">Open as one of:</p>
        <ul className="mt-2 flex gap-3 text-sm underline">
          {ActorIdSchema.options.map((a) => (
            <li key={a}>
              <a href={`?as=${a}`}>{a}</a>
            </li>
          ))}
        </ul>
      </div>
    </PhoneFrame>
  );
}

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-gray-200">
      <main className="relative mx-auto min-h-dvh max-w-[420px] bg-gray-50 font-sans text-gray-900">
        {children}
      </main>
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
  return (
    <PhoneFrame>
      <div
        className="min-h-dvh touch-pan-y pb-28 select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (start.current = null)}
      >
        {trip.state?.fakes && <FakesBanner />}
        {trip.state?.ledger.chainValid === false && (
          <div className="px-4 pt-3">
            <div role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">
              <p>The relay sent an entry this phone rejects.</p>
              <p className="font-medium">
                Your agent stopped trusting it and keeps its own copy. Tell the coordinator.
              </p>
            </div>
          </div>
        )}
        {trip.error && (
          <div className="px-4 pt-3">
            <ErrorBox error={trip.error} />
          </div>
        )}
        <View as={as} trip={trip} go={go} />
      </div>
      <BottomBar screen={screen} go={go} />
    </PhoneFrame>
  );
}

/** Floating pill, three buttons of equal weight; the content scrolls behind it. */
function BottomBar({ screen, go }: { screen: Screen; go: (s: Screen) => void }) {
  const items: { to: Screen; label: string; icon: string }[] = [
    { to: 'groups', label: 'Groups', icon: '🫂' },
    { to: 'new', label: 'New expense', icon: '📷' },
    { to: 'qr', label: 'QR', icon: '▦' },
  ];
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-4 z-20 mx-auto flex max-w-[420px] justify-center px-4">
      <div className="pointer-events-auto grid w-full max-w-xs grid-cols-3 gap-1 rounded-full border border-gray-200 bg-white/85 p-1.5 shadow-lg backdrop-blur">
        {items.map(({ to, label, icon }) => (
          <button
            key={to}
            type="button"
            onClick={() => go(to)}
            aria-label={label}
            aria-current={screen === to ? 'page' : undefined}
            className={`flex h-12 flex-col items-center justify-center rounded-full text-xs font-medium ${screen === to ? 'bg-gray-900 text-white' : 'text-gray-700'}`}
          >
            <span className="text-lg leading-none">{icon}</span>
            {label === 'New expense' ? 'New' : label}
          </button>
        ))}
      </div>
    </nav>
  );
}
