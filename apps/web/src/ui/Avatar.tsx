// Round avatar with the initial (DESIGN.md §7). Me in the accent tint, others on the gray fill.

const SIZE = {
  32: 'size-8 text-subhead',
  40: 'size-10 text-headline',
  80: 'size-20 text-large-title',
};

export function Avatar({
  name,
  me = false,
  size = 40,
}: {
  name: string;
  me?: boolean;
  size?: keyof typeof SIZE;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-semibold uppercase ${SIZE[size]} ${me ? 'bg-accent-soft text-label' : 'bg-bg-fill text-label'}`}
    >
      {name.slice(0, 1)}
    </span>
  );
}
