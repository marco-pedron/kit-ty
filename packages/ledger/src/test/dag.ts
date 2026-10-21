import fc from 'fast-check';
import { KIND_REGISTRY, nostrEventId, registryTags } from '@kitty/shared';

// Registry-shaped DAGs with real NIP-01 ids, for order.ts and conflicts.ts tests.

export const TRIP_TAG = 'f'.repeat(64);

export interface TestEvent {
  id: string;
  parents: string[];
  author: string;
  created_at: number;
}

/** An event whose id is the NIP-01 id of a kind-7345 event citing `parents`. */
export function ev(
  parents: readonly string[],
  opts: { author?: string; createdAt?: number; salt?: string } = {},
): TestEvent {
  const author = opts.author ?? 'a'.repeat(64);
  const created_at = opts.createdAt ?? 1_760_000_000;
  const tags = registryTags(TRIP_TAG, parents);
  const id = nostrEventId({
    pubkey: author,
    created_at,
    kind: KIND_REGISTRY,
    tags,
    content: opts.salt ?? '',
  });
  return { id, parents: [...new Set(parents)].sort(), author, created_at };
}

const AUTHORS = ['1', '2', '3', '4'].map((c) => c.repeat(64));

/**
 * A random DAG: one genesis, then up to `max` events, each citing 1-4 earlier ones, with
 * arbitrary authors and created_at (also older than their parents, or far in the future).
 */
export const dag = (max = 40): fc.Arbitrary<TestEvent[]> =>
  fc
    .array(
      fc.record({
        parentPicks: fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        author: fc.nat({ max: AUTHORS.length - 1 }),
        createdAt: fc.integer({ min: 0, max: 4_000_000_000 }),
        salt: fc.string({ maxLength: 4 }),
      }),
      { maxLength: max, size: 'max' },
    )
    .map((recipe) => {
      const events = [ev([], { salt: 'genesis' })];
      for (const r of recipe) {
        const parents = r.parentPicks.map((p) => (events[p % events.length] as TestEvent).id);
        events.push(
          ev(parents, {
            author: AUTHORS[r.author] as string,
            createdAt: r.createdAt,
            salt: r.salt,
          }),
        );
      }
      return events;
    });

/** The fixed order by brute force: repeatedly the smallest id whose parents are all out. */
export function referenceOrder(events: readonly TestEvent[]): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  const roots = events
    .filter((e) => e.parents.length === 0)
    .map((e) => e.id)
    .sort();
  if (roots[0] === undefined) return out;
  out.push(roots[0]);
  done.add(roots[0]);
  for (;;) {
    const ready = events
      .filter((e) => !done.has(e.id) && e.parents.length > 0 && e.parents.every((p) => done.has(p)))
      .map((e) => e.id)
      .sort();
    if (ready[0] === undefined) return out;
    out.push(ready[0]);
    done.add(ready[0]);
  }
}

/** All descendants of `id` (not itself). */
export function descendants(events: readonly TestEvent[], id: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of events)
      if (!out.has(e.id) && e.parents.some((p) => p === id || out.has(p))) {
        out.add(e.id);
        grew = true;
      }
  }
  return out;
}
