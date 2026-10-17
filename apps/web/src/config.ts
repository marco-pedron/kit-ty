// UI switches of the traveler app, in one place.

/**
 * Shows a second, simulated group ("Group 2"): greyed out, not clickable, made-up rows, so the
 * Home and Groups screens look like the PM's prototype. false = single-group layout: no card,
 * the trip title and its history scrolling to the bottom, behind the floating bar.
 */
export const SHOW_DEMO_SECOND_GROUP = true;

/** Polling period of GET /state (SPEC §14: the UI renders only from it). */
export const POLL_MS = 1000;

/** Minimum horizontal travel, in px, for a swipe between screens. */
export const SWIPE_MIN_PX = 60;
