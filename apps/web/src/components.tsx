import { formatCents, type ApiClientError } from '@kitty/shared';
import type { ReactNode } from 'react';
import type { Screen } from './nav.js';

// Small building blocks shared by every screen.

export function Money({ cents, unit = true }: { cents: bigint; unit?: boolean }) {
  return (
    <span className="tabular-nums">
      {formatCents(cents)}
      {unit && <span className="ml-1 text-[0.7em] font-medium text-gray-500">DUSD</span>}
    </span>
  );
}

/** Every error with its suggested next step (C7). */
export function ErrorBox({ error }: { error: ApiClientError }) {
  return (
    <div role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">
      <p>{error.message}</p>
      <p className="font-medium">{error.action}</p>
    </div>
  );
}

export function FakesBanner() {
  return (
    <div className="bg-amber-200 px-4 py-1.5 text-center text-xs font-semibold text-amber-900">
      Fakes on: simulated wallet and AI, no real RGB transactions
    </div>
  );
}

/** The kit+ty mark, top right of Home; opens the profile. */
export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Profile"
      className="grid size-10 place-items-center rounded-full bg-pink-100 text-xl"
    >
      🐱
    </button>
  );
}

/** Title row of the secondary screens, with the way back. */
export function ScreenHeader({
  title,
  back,
  go,
}: {
  title: string;
  back: Screen;
  go: (s: Screen) => void;
}) {
  return (
    <header className="flex items-center gap-2 px-4 pt-4 pb-2">
      <button
        type="button"
        onClick={() => go(back)}
        aria-label="Back"
        className="-ml-2 rounded-full px-2 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100"
      >
        ‹
      </button>
      <h1 className="text-lg font-semibold">{title}</h1>
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-gray-500">{children}</p>;
}
