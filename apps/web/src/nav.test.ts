import { describe, expect, it } from 'vitest';
import { hashOf, screenFromHash, swipeDirection, swipeTarget } from './nav.js';

describe('screens in the URL hash', () => {
  it('reads the screen, defaulting to home', () => {
    expect(screenFromHash('#/qr')).toBe('qr');
    expect(screenFromHash('#profile')).toBe('profile');
    expect(screenFromHash('')).toBe('home');
    expect(screenFromHash('#/nope')).toBe('home');
  });

  it('round-trips every screen', () => {
    for (const s of ['home', 'new', 'qr', 'groups', 'group', 'profile'] as const)
      expect(screenFromHash(hashOf(s))).toBe(s);
  });
});

describe('swipes', () => {
  it('needs a mostly horizontal move of at least the minimum', () => {
    expect(swipeDirection(-80, 10, 60)).toBe('left');
    expect(swipeDirection(80, -10, 60)).toBe('right');
    expect(swipeDirection(59, 0, 60)).toBeNull();
    expect(swipeDirection(80, 70, 60)).toBeNull();
  });

  it('goes from home to new expense (left) and QR (right), and back', () => {
    expect(swipeTarget('home', 'left')).toBe('new');
    expect(swipeTarget('home', 'right')).toBe('qr');
    expect(swipeTarget('new', 'right')).toBe('home');
    expect(swipeTarget('qr', 'left')).toBe('home');
    expect(swipeTarget('new', 'left')).toBeNull();
    expect(swipeTarget('groups', 'left')).toBeNull();
  });
});
