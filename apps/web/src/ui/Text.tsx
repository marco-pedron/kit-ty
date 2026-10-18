import { formatCents } from '@kitty/shared';
import wordmark from '../assets/kitty-wordmark.svg?raw';

// Brand and money typography (DESIGN.md §4): Zilla Slab only for the kit+ty wordmark and the
// +ty / -ty prefixes; amounts in the UI font with tabular figures.

/** kit-ty_brand/kitty-wordmark.svg inlined: the letters in currentColor, the "+" in pink. */
export function Wordmark({ size = 'title2' }: { size?: 'title2' | 'large' }) {
  return (
    <span
      role="img"
      aria-label="kit+ty"
      className={`inline-block text-label ${size === 'large' ? 'h-12' : 'h-7'}`}
      dangerouslySetInnerHTML={{
        __html: wordmark.replace(
          / role="img" aria-label="[^"]*"/,
          ' aria-hidden="true" height="100%"',
        ),
      }}
    />
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
