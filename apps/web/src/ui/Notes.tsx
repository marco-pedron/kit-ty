import type { ApiClientError } from '@kitty/shared';
import type { ReactNode } from 'react';
import { humanError } from '../errors.js';
import { useNow } from '../state.js';
import { Button } from './Button.js';
import { Mascot } from './Mascot.js';

// Errors, banners and waits (DESIGN.md §2, §7; task C7). An error is a human sentence and one next
// step (errors.ts), never a code; red only for errors. Every wait says what is happening, with
// the time elapsed and the kitten.

export function ErrorNote({
  error,
  onRetry,
  who,
  className = '',
}: {
  error: ApiClientError;
  onRetry?: () => void;
  /** Whose node, when the error is about a node ("Bob's node is not answering"). */
  who?: string;
  className?: string;
}) {
  const h = humanError(error, who);
  return (
    <div role="alert" className={`rounded-control bg-danger-soft px-3 py-2.5 ${className}`}>
      <p className="text-subhead font-semibold text-label">{h.title}</p>
      <p className="text-subhead text-label">{h.action}</p>
      {error.message !== h.title && (
        <p className="mt-1 text-footnote [overflow-wrap:anywhere] text-label-2">{error.message}</p>
      )}
      {onRetry !== undefined && h.retry && (
        <Button variant="plain" onClick={onRetry} className="-ml-4">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Banner({
  children,
  tone = 'accent',
}: {
  children: string;
  /** accent: needs attention (fakes on, log rejected); quiet: passing state (reconnecting). */
  tone?: 'accent' | 'quiet';
}) {
  return (
    <p
      role={tone === 'quiet' ? 'status' : undefined}
      className={`truncate px-4 py-1 text-center text-caption font-semibold ${tone === 'quiet' ? 'bg-bg-fill text-label-2' : 'bg-accent-soft text-label'}`}
    >
      {children}
    </p>
  );
}

/** "12 s", "1:05": time since `since` (ms or ISO), ticking. */
export function Elapsed({ since }: { since: number | string }) {
  const now = useNow(500);
  const start = typeof since === 'number' ? since : Date.parse(since);
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return (
    <span className="tabular">
      {s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
    </span>
  );
}

/** The agent's long steps in progress, floating above the tab bar: kitten, what, how long. */
export function OperationsDock({
  operations,
}: {
  operations: readonly { id: string; text: string; startedAt: string }[];
}) {
  if (operations.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-[430px] flex-col items-center gap-2 px-4"
    >
      {operations.map((o) => (
        <div
          key={o.id}
          role="status"
          className="hairline animate-fade flex min-h-11 max-w-full items-center gap-2 rounded-full bg-bg-cell py-1 pr-4 pl-2"
        >
          <Mascot size={40} />
          <span className="truncate text-subhead">{o.text}</span>
          <span className="shrink-0 text-footnote text-label-2">
            <Elapsed since={o.startedAt} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** An empty list inside a section: the kitten, small, and one sentence. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Mascot size={40} waving={false} />
      <p className="text-subhead text-label-2">{children}</p>
    </div>
  );
}
