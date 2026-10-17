import { formatCents } from '@kitty/shared';

// Brand and money typography (DESIGN.md §4): Zilla Slab only for the kit+ty wordmark and the
// +ty / -ty prefixes; amounts in the UI font with tabular figures.

export function Wordmark({ size = 'title2' }: { size?: 'title2' | 'large' }) {
  return (
    <span
      className={`font-brand font-bold text-label ${size === 'large' ? 'text-large-title' : 'text-title2'}`}
    >
      kit<span className="text-cat-line">+</span>ty
    </span>
  );
}

/** "+17.44" on a positive-soft pill, "−3.09" plain, "52.32" unsigned (§3 roles). */
export function Amount({
  cents,
  sign = null,
  unit = false,
}: {
  cents: bigint;
  sign?: '+' | '-' | null;
  unit?: boolean;
}) {
  const text = `${sign === '+' ? '+' : sign === '-' ? '−' : ''}${formatCents(cents)}`;
  return (
    <span
      className={`tabular text-headline font-semibold text-label ${sign === '+' ? 'rounded-full bg-positive-soft px-2 py-0.5' : ''}`}
    >
      {text}
      {unit && <span className="ml-1 text-footnote font-normal text-label-2">DUSD</span>}
    </span>
  );
}
