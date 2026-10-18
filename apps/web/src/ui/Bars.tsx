import { ChevronLeft } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

// Navigation bar and floating tab bar (DESIGN.md §5, §7): opaque --bg-cell with a 0.5px
// separator, no blur. A large title collapses into the bar once the page scrolls.

function useScrolled(threshold = 36): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > threshold);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [threshold]);
  return scrolled;
}

export function NavBar({
  title,
  back,
  large = false,
  trailing,
}: {
  title: string;
  back?: { label: string; onClick: () => void };
  /** Large Title under the bar, collapsing into it on scroll (Groups, Profile). */
  large?: boolean;
  trailing?: ReactNode;
}) {
  const scrolled = useScrolled();
  const inlineTitle = !large || scrolled;
  return (
    <>
      <header
        className={`sticky top-0 z-20 bg-bg-cell pt-[env(safe-area-inset-top)] ${large && !scrolled ? 'bg-bg-grouped' : 'hairline-b'}`}
      >
        <div className="relative flex h-11 items-center px-2">
          {back !== undefined && (
            <button
              type="button"
              onClick={back.onClick}
              className="pressable z-10 flex min-h-11 min-w-11 items-center text-body text-accent-text"
            >
              <ChevronLeft size={28} strokeWidth={1.75} className="-mr-0.5" />
              <span className="max-w-[5.5rem] truncate">{back.label}</span>
            </button>
          )}
          <h1
            className={`pointer-events-none absolute inset-x-[7.5rem] truncate text-center text-headline font-semibold transition-opacity duration-300 ${inlineTitle ? 'opacity-100' : 'opacity-0'}`}
            aria-hidden={!inlineTitle}
          >
            {title}
          </h1>
          <span className="ml-auto flex items-center">{trailing}</span>
        </div>
      </header>
      {large && (
        <h1 className="px-4 pt-1 pb-2 text-large-title font-bold" aria-hidden={inlineTitle}>
          {title}
        </h1>
      )}
    </>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: string;
  icon: ReactNode;
}

/** Floating pill, identical buttons (three or four), the active one in the accent (§7). */
export function TabBar<K extends string>({
  items,
  active,
  onSelect,
}: {
  items: readonly TabItem<K>[];
  active: K | null;
  onSelect: (k: K) => void;
}) {
  return (
    <nav
      aria-label="Main"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-[430px] justify-center px-4"
    >
      <div className="hairline pointer-events-auto flex gap-1 rounded-full bg-bg-cell p-1.5">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onSelect(it.key)}
            aria-current={active === it.key ? 'page' : undefined}
            className={`pressable flex h-[52px] flex-col items-center justify-center gap-0.5 rounded-full text-caption font-semibold active:bg-bg-fill ${items.length > 3 ? 'w-[68px]' : 'w-[76px]'} ${active === it.key ? 'text-accent-text' : 'text-label-2'}`}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
