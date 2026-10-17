import { formatCents, type ApiClientError } from '@kitty/shared';
import type { ReactNode } from 'react';
import { Mascot } from './Mascot.js';
import { paymentMode } from './mode.js';
import type { Screen } from './nav.js';
import type { Toast } from './toasts.js';

// Small building blocks shared by every screen, in the visual identity of docs/DESIGN.md:
// palette tokens only, no shadows, no gradients, no transparency.

export function Money({ cents, unit = true }: { cents: bigint; unit?: boolean }) {
  return (
    <span className="amount">
      {formatCents(cents)}
      {unit && <span className="ml-1 font-sans text-small text-ink-muted">DUSD</span>}
    </span>
  );
}

/** Every error: a human sentence and the next step (§2). */
export function ErrorBox({ error }: { error: ApiClientError }) {
  return <Alert title={error.message}>{error.action}</Alert>;
}

export function Alert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="card-attention py-3">
      <p>{title}</p>
      <p className="font-semibold">{children}</p>
    </div>
  );
}

export function FakesBanner() {
  return (
    <div className="bg-pink-soft px-4 py-1.5 text-center text-small font-semibold text-ink">
      Fakes on: simulated wallet and AI, no real RGB transactions
    </div>
  );
}

/** The kit+ty wordmark with the pink "+" (§1); top right of Home, opens the profile. */
export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Profile"
      className="font-slab text-title font-bold text-plum"
    >
      kit<span className="text-pink">+</span>ty
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
    <header className="flex items-center gap-2 px-4 pt-4 pb-3">
      <button
        type="button"
        onClick={() => go(back)}
        aria-label="Back"
        className="-ml-2 rounded-full px-2 py-1 text-title leading-none text-plum"
      >
        ‹
      </button>
      <h1 className="text-title text-ink">{title}</h1>
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-ink-muted">{children}</p>;
}

// ---------- badges (§7) ----------

export type BadgeKind =
  'auto' | 'limit' | 'ask' | 'active' | 'insolvent' | 'excluded' | 'operator' | 'joining';

const BADGE: Record<BadgeKind, string> = {
  auto: 'bg-mint',
  limit: 'bg-teal-soft',
  ask: 'bg-line',
  active: 'bg-mint-soft',
  insolvent: 'bg-pink-soft border-pink',
  excluded: 'bg-line line-through',
  operator: 'bg-plum-soft',
  joining: 'bg-line',
};

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
  return <span className={`badge ${BADGE[kind]}`}>{children}</span>;
}

/** The group's payment mode as a badge: "Auto mode", "Always ask" or "Limit X.XX". */
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      aria-label={`${mode.long}. Change the limit`}
      className={`badge shrink-0 ${BADGE[mode.kind]}`}
    >
      {mode.badge}
    </button>
  );
}

// ---------- people ----------

const AVATAR: Record<string, string> = {
  alice: 'bg-plum-soft',
  bob: 'bg-teal-soft',
  charlie: 'bg-mint-soft',
};

/** Round avatar with the initial, on the member's soft tint (§6). */
export function Avatar({ m, size = 40 }: { m: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full font-slab font-bold text-ink uppercase ${AVATAR[m] ?? 'bg-pink-soft'}`}
    >
      {m.slice(0, 1)}
    </span>
  );
}

// ---------- +ty / -ty toasts (§7) ----------

export function Toasts({ toasts }: { toasts: readonly Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="fixed inset-x-0 top-3 z-30 mx-auto flex max-w-[420px] flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-2 rounded-full border-[1.5px] border-line py-1 pr-4 pl-1 text-ink ${t.kind === 'plus' ? 'bg-mint-soft' : 'bg-plum-soft pl-4'}`}
        >
          {t.kind === 'plus' && <Mascot size={48} wave={false} />}
          <span className="font-slab text-amount font-bold">{t.prefix}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
