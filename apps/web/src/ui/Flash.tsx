import { Check } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

// A short confirmation that something happened ("Copied!"), at the bottom above the tab bar, for
// 1.5 s; and the copy button that uses it (Proof › Details).

const FLASH_MS = 1500;

let current: { id: number; text: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function flash(text: string) {
  const id = (current?.id ?? 0) + 1;
  current = { id, text };
  emit();
  setTimeout(() => {
    if (current?.id === id) {
      current = null;
      emit();
    }
  }, FLASH_MS);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function FlashHost() {
  const f = useSyncExternalStore(subscribe, () => current);
  if (f === null) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom))] z-50 flex justify-center"
    >
      <span
        key={f.id}
        className="animate-fade inline-flex items-center gap-1.5 rounded-full bg-label px-4 py-2 text-subhead font-semibold text-bg-cell"
      >
        <Check size={16} strokeWidth={2.5} />
        {f.text}
      </span>
    </div>,
    document.body,
  );
}

/** "Copy" that turns into a check and "Copied" for 1.5 s, with the flash. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => {
      setCopied(true);
      flash('Copied!');
      setTimeout(() => setCopied(false), FLASH_MS);
    };
    // The clipboard API needs a secure context (localhost is one); fall back to execCommand.
    if (navigator.clipboard !== undefined)
      void navigator.clipboard.writeText(value).then(done, () => fallback(value) && done());
    else if (fallback(value)) done();
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={`pressable inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-subhead active:bg-bg-fill ${copied ? 'font-semibold text-label' : 'text-accent-text'}`}
    >
      {copied && (
        <span className="grid size-5 place-items-center rounded-full bg-positive text-on-positive">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function fallback(value: string): boolean {
  const t = document.createElement('textarea');
  t.value = value;
  t.setAttribute('readonly', '');
  t.style.position = 'fixed';
  t.style.opacity = '0';
  document.body.appendChild(t);
  t.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    t.remove();
  }
}
