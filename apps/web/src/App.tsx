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

/** Floating: the content scrolls behind it. Groups · camera (new expense) · QR. */
function BottomBar({ screen, go }: { screen: Screen; go: (s: Screen) => void }) {
  const item = (s: Screen, label: string, icon: ReactNode, big = false) => (
    <button
      type="button"
      onClick={() => go(s)}
      aria-label={label}
      aria-current={screen === s ? 'page' : undefined}
      className={
        big
          ? 'grid size-14 -translate-y-3 place-items-center rounded-full bg-pink-500 text-2xl text-white shadow-lg ring-4 ring-gray-50'
          : `flex w-16 flex-col items-center text-xs font-medium ${screen === s ? 'text-pink-700' : 'text-gray-600'}`
      }
    >
      {icon}
    </button>
  );
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-4 z-20 mx-auto flex max-w-[420px] justify-center px-4">
      <div className="pointer-events-auto flex h-14 w-full max-w-xs items-center justify-around rounded-full border border-gray-200 bg-white/85 shadow-lg backdrop-blur">
        {item(
          'groups',
          'Groups',
          <>
            <span className="text-lg">🫂</span>Groups
          </>,
        )}
        {item('new', 'New expense', '📷', true)}
        {item(
          'qr',
          'QR',
          <>
            <span className="text-lg">▦</span>QR
          </>,
        )}
      </div>
    </nav>
  );
}
