import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

// Inset grouped list (DESIGN.md §7), as in Settings: a Footnote uppercase header, rows on
// --bg-cell with radius 14, 0.5px separators inset after the leading element.

export function Section({
  header,
  footer,
  children,
  className = '',
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {header !== undefined && (
        <h2 className="px-4 pb-1.5 text-footnote font-normal tracking-wide text-label-2 uppercase">
          {header}
        </h2>
      )}
      <div className="overflow-hidden rounded-card bg-bg-cell">{children}</div>
      {footer !== undefined && <p className="px-4 pt-1.5 text-footnote text-label-2">{footer}</p>}
    </section>
  );
}

export function Row({
  leading,
  title,
  subtitle,
  value,
  chevron = false,
  onClick,
  disabled = false,
  last = false,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** No separator under the last row of a section. */
  last?: boolean;
}) {
  const body = (
    <>
      {leading !== undefined && <span className="shrink-0 py-2">{leading}</span>}
      <span
        className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 ${last ? '' : 'hairline-b'}`}
      >
        <span className="min-w-0 flex-1 text-left">
          <span className={`block truncate text-body ${disabled ? 'text-label-3' : 'text-label'}`}>
            {title}
          </span>
          {subtitle !== undefined && (
            <span className="block truncate text-subhead text-label-2">{subtitle}</span>
          )}
        </span>
        {value !== undefined && (
          <span className={`shrink-0 ${disabled ? 'text-label-3' : 'text-label-2'}`}>{value}</span>
        )}
        {chevron && <ChevronRight size={18} strokeWidth={1.75} className="shrink-0 text-label-3" />}
      </span>
    </>
  );
  const cls = 'flex w-full items-center gap-3 pl-4';
  if (onClick === undefined || disabled)
    return (
      <div className={cls} aria-disabled={disabled || undefined}>
        {body}
      </div>
    );
  return (
    <button type="button" onClick={onClick} className={`${cls} pressable`}>
      {body}
    </button>
  );
}

/** A coloured square with an icon, radius 7 (Settings rows). */
export function Tile({
  children,
  tone = 'fill',
}: {
  children: ReactNode;
  tone?: 'fill' | 'accent';
}) {
  return (
    <span
      className={`grid size-[30px] place-items-center rounded-tile ${tone === 'accent' ? 'bg-accent text-on-accent' : 'bg-bg-fill text-label'}`}
    >
      {children}
    </span>
  );
}
