import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

// Light / dark toggle (brief §6.3): <html data-theme>, set before the first paint by index.html.
// A choice made here is saved; until then the theme follows the system, live.

type Theme = 'light' | 'dark';
const KEY = 'kitty:theme';

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

const system = (): Theme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

function apply(t: Theme) {
  document.documentElement.dataset['theme'] = t;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => saved() ?? system());
  useEffect(() => {
    apply(theme);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => saved() === null && setTheme(system());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private window or blocked storage: the choice lasts until reload.
    }
    setTheme(next);
  };
  return [theme, toggle];
}

/** Sun in dark (tap: go light), moon in light (tap: go dark); 44×44 target. */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="pressable grid size-11 place-items-center rounded-full text-label-2 active:bg-bg-fill"
    >
      {dark ? <Sun size={22} strokeWidth={1.75} /> : <Moon size={22} strokeWidth={1.75} />}
    </button>
  );
}
