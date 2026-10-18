import { useEffect, useState } from 'react';

// The bottom of a screen that scrolls (brief §6.4): a fade with a light blur says there is more
// below; it never takes a tap (pointer-events none) and goes away at the end of the page.

const SLACK_PX = 8;

export function ScrollFade() {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const check = () => {
      const el = document.documentElement;
      setMore(el.scrollHeight - window.innerHeight - window.scrollY > SLACK_PX);
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    // Content grows without a scroll (polling, a screen push): look again when the page changes.
    const ro = new ResizeObserver(check);
    ro.observe(document.body);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      ro.disconnect();
    };
  }, []);
  return (
    <div
      aria-hidden
      className={`scroll-fade pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto h-36 max-w-[430px] ${more ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}
