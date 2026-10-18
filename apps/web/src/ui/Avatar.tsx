import { CatHead, headOf, type HeadVariant } from './CatHead.js';

// Round avatar with the member's cat head (DESIGN.md §7). Me in the accent tint, others on the
// gray fill. `variant` overrides the head, e.g. "out" for an excluded member.

const SIZE = { 32: 'size-8', 40: 'size-10', 80: 'size-20', 96: 'size-24' };

export function Avatar({
  name,
  me = false,
  size = 40,
  variant,
}: {
  name: string;
  me?: boolean;
  size?: keyof typeof SIZE;
  variant?: HeadVariant;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full ${SIZE[size]} ${me ? 'bg-accent-soft' : 'bg-bg-fill'}`}
    >
      <CatHead variant={variant ?? headOf(name)} size={Math.round(size * 0.92)} />
    </span>
  );
}
