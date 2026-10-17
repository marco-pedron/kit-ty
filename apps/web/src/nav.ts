import { SWIPE_MIN_PX } from './config.js';

// Screens of the traveler app and how to move between them (PM prototype): the bottom bar
// (Groups · camera · QR), swipes from Home (left = new expense, right = QR) and back again,
// taps on the group and on the logo. The screen lives in the URL hash, so a reload keeps it.

export const SCREENS = ['home', 'new', 'qr', 'groups', 'group', 'profile'] as const;
export type Screen = (typeof SCREENS)[number];

export function screenFromHash(hash: string): Screen {
  const name = hash.replace(/^#\/?/, '');
  return (SCREENS as readonly string[]).includes(name) ? (name as Screen) : 'home';
}

export const hashOf = (screen: Screen): string => (screen === 'home' ? '' : `#/${screen}`);

export type SwipeDirection = 'left' | 'right';

/** A mostly horizontal move of at least `min` px; `left` = the finger moved to the left. */
export function swipeDirection(dx: number, dy: number, min = SWIPE_MIN_PX): SwipeDirection | null {
  if (Math.abs(dx) < min || Math.abs(dx) < 1.5 * Math.abs(dy)) return null;
  return dx < 0 ? 'left' : 'right';
}

/** Where a swipe leads from each screen; null = nowhere. */
export function swipeTarget(from: Screen, dir: SwipeDirection): Screen | null {
  if (from === 'home') return dir === 'left' ? 'new' : 'qr';
  if (from === 'new') return dir === 'right' ? 'home' : null;
  if (from === 'qr') return dir === 'left' ? 'home' : null;
  return null;
}
