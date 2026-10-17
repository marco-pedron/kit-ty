import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Mascot } from './Mascot.js';
import { Button } from './Button.js';

// Sheet, toast and the loading / empty / error states (DESIGN.md §7).

/** From the bottom, with a grabber; the screen behind is dimmed. Escape or a tap outside closes. */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // A portal: an animated ancestor (the screen push) must not become the sheet's frame.
  return createPortal(
    <div className="fixed inset-0 z-40" data-noswipe>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="animate-fade absolute inset-0 bg-scrim"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        className="animate-sheet absolute inset-x-0 bottom-0 mx-auto max-w-[430px] rounded-t-sheet bg-bg-cell px-4 pt-2 pb-[calc(24px+env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-3 h-[5px] w-9 rounded-full bg-label-3" />
        <h2 id="sheet-title" className="text-title2 font-bold">
          {title}
        </h2>
        {subtitle !== undefined && <p className="mt-0.5 text-subhead text-label-2">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface ToastItem {
  id: string;
  kind: 'plus' | 'minus';
  prefix: string;
  text: string;
}

/** +ty on positive-soft, -ty on accent-soft, the kitten at 22px, the prefix in Zilla Slab. */
export function Toasts({ toasts }: { toasts: readonly ToastItem[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(8px+env(safe-area-inset-top))] z-50 mx-auto flex max-w-[430px] flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-toast flex min-h-11 items-center gap-2 rounded-full py-1.5 pr-4 pl-2.5 text-subhead text-label ${t.kind === 'plus' ? 'bg-positive-soft' : 'bg-accent-soft'}`}
        >
          <Mascot size={22} waving={false} />
          <span className="font-brand text-headline font-bold">{t.prefix}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Loading (the kitten waves), empty (kitten + title + text + action), error (sentence + retry). */
export function StateView({
  kind,
  title,
  text,
  action,
}: {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  text?: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className="flex flex-col items-center px-8 py-10 text-center"
    >
      {kind !== 'error' && (
        <Mascot size={kind === 'loading' ? 128 : 96} waving={kind === 'loading'} />
      )}
      <p className="mt-4 text-headline font-semibold">{title}</p>
      {text !== undefined && <p className="mt-1 text-subhead text-label-2">{text}</p>}
      {action !== undefined && (
        <Button
          variant={kind === 'error' ? 'gray' : 'plain'}
          onClick={action.onClick}
          className="mt-4"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
