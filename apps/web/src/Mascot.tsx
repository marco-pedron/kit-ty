import type { ReactNode } from 'react';
import { useNow } from './state.js';

// The +ty kitten (docs/DESIGN.md §8): a maneki-neko, ink outline, warm-white inside, pink and
// plum details, uniform 2px stroke. The raised paw is its own group so it can wave (index.css,
// .mascot-paw: about 20° back and forth around the shoulder, still with prefers-reduced-motion).
// A first version drawn in code; the PM may replace it.

export function Mascot({ size = 64, wave = true }: { size?: number; wave?: boolean }) {
  const outline = 'fill-surface stroke-ink';
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label="kit+ty kitten"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* ears, behind the head */}
      <path className={outline} d="M29 32 L31 11 L46 23 Z" />
      <path className={outline} d="M71 32 L69 11 L54 23 Z" />
      <path className="fill-pink" d="M33 26 L34 17 L41 23 Z" />
      <path className="fill-pink" d="M67 26 L66 17 L59 23 Z" />
      {/* body and the paw resting on it */}
      <path className={outline} d="M28 94 Q25 60 50 59 Q75 60 72 94 Z" />
      <ellipse className={outline} cx="40" cy="91" rx="7" ry="4" />
      {/* head */}
      <ellipse className={outline} cx="50" cy="40" rx="25" ry="21" />
      <path className="fill-none stroke-ink" d="M39 40 q3 -3 6 0 M55 40 q3 -3 6 0" />
      <path className="fill-pink stroke-none" d="M48 45 h4 l-2 2.5 Z" />
      <path className="fill-none stroke-ink" d="M47 50 q3 2.5 6 0" />
      <circle className="fill-pink stroke-none" cx="35" cy="47" r="3" />
      <circle className="fill-pink stroke-none" cx="65" cy="47" r="3" />
      <path className="fill-none stroke-ink" d="M24 44 h7 M24 48 h7 M69 44 h7 M69 48 h7" />
      {/* collar and bell */}
      <path className="fill-plum stroke-ink" d="M31 60 Q50 68 69 60 L69 64 Q50 72 31 64 Z" />
      <circle className="fill-pink stroke-ink" cx="50" cy="69" r="4" />
      {/* the waving paw, pivot on the shoulder (68, 58) */}
      <g className={wave ? 'mascot-paw' : undefined}>
        <path className={outline} d="M62 68 C64 54 69 42 71 34 L82 36 C80 46 76 58 72 68 Z" />
        <ellipse className={outline} cx="77" cy="32" rx="7.5" ry="6.5" />
        <circle className="fill-pink stroke-none" cx="77" cy="33" r="2.5" />
      </g>
    </svg>
  );
}

/** Every wait (§2, §8): the kitten waving, what is happening, and the time elapsed. */
export function Loading({
  children,
  since,
  size = 64,
}: {
  children: ReactNode;
  since?: number;
  size?: number;
}) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
      <Mascot size={size} />
      <p className="text-ink-muted">
        {children}
        {since !== undefined && <Elapsed since={since} />}
      </p>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow(500);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="ml-1 tabular-nums">{s} s</span>;
}
