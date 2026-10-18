// Short waits (< 3 s: send, approve, saving the slider; DESIGN.md §7): the brand "+" spins on the
// crossing of its two bars, slow in and slow out, and after a few turns lies down as a "−".
// Long waits use the waving kitten instead.

export function PlusMinus({ size = 20, label = 'Working' }: { size?: number; label?: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="plusminus shrink-0 text-cat-line"
    >
      <rect x="2" y="10" width="20" height="4" rx="1" fill="currentColor" />
      <rect className="plusminus-v" x="10" y="2" width="4" height="20" rx="1" fill="currentColor" />
    </svg>
  );
}

/** A button label while it waits: the loader and a word ("Signing…"). */
export function Working({ text = 'Signing…' }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <PlusMinus size={16} label={text} />
      <span aria-hidden>{text}</span>
    </span>
  );
}
