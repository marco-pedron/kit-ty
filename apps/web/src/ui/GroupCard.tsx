import type { ReactNode } from 'react';

/**
 * A group: its title and limit in a header of their own colour, the content under it, so the
 * limit reads as this group's (brief §3.1). Muted: a group not active yet.
 */
export function GroupCard({
  title,
  badge,
  muted = false,
  children,
  'aria-label': ariaLabel,
}: {
  title: string;
  badge?: ReactNode;
  muted?: boolean;
  children: ReactNode;
  'aria-label'?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={`overflow-hidden ${muted ? 'rounded-card border border-dashed border-separator' : 'card'}`}
    >
      <header
        className={`flex min-h-12 items-center justify-between gap-3 px-4 py-2 ${muted ? 'bg-bg-fill' : 'bg-accent text-on-accent'}`}
      >
        <h2 className={`truncate text-title2 font-bold ${muted ? 'text-label-3' : ''}`}>{title}</h2>
        {badge}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
