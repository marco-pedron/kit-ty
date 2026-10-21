import fc from 'fast-check';
import { sha256Hex } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from './hex.js';
import { fixedOrder, OrderError, stateHash } from './order.js';
import { dag, descendants, ev, referenceOrder, type TestEvent } from './test/dag.js';

const ids = (es: readonly { id: string }[]) => es.map((e) => e.id);

describe('fixedOrder', () => {
  const g = ev([], { salt: 'genesis' });
  const a = ev([g.id], { salt: 'a' });
  const b = ev([g.id], { salt: 'b' });
  const c = ev([a.id, b.id], { salt: 'c' });

  it('puts parents first and breaks ties on the smallest id', () => {
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(ids(fixedOrder([c, b, a, g]).order)).toEqual([g.id, first?.id, second?.id, c.id]);
  });

  it('gives frontier and stateHash of the closed set', () => {
    const r = fixedOrder([g, a, b]);
    expect(r.frontier).toEqual([a.id, b.id].sort());
    expect(fixedOrder([g, a, b, c]).frontier).toEqual([c.id]);
    expect(r.stateHash).toBe(stateHash(ids(r.order)));
  });

  it('stateHash = sha256 of the concatenated 32-byte ids', () => {
    const seq = [g.id, a.id];
    const bytes = new Uint8Array([...hexToBytes(g.id), ...hexToBytes(a.id)]);
    expect(stateHash(seq)).toBe(sha256Hex(bytes));
    expect(stateHash([])).toBe(sha256Hex(new Uint8Array()));
    expect(stateHash([a.id, g.id])).not.toBe(stateHash(seq));
  });

  it('keeps an event with a missing parent waiting, and lists what to fetch', () => {
    const r = fixedOrder([g, a, c]);
    expect(ids(r.order)).toEqual([g.id, a.id]);
    expect(ids(r.waiting)).toEqual([c.id]);
    expect(r.missing).toEqual([b.id]);
    expect(r.causality.has(c.id)).toBe(false);
  });

  it('waits for the whole chain, not only the direct parent', () => {
    const d = ev([c.id], { salt: 'd' });
    const r = fixedOrder([g, a, c, d]);
    expect(ids(r.waiting).sort()).toEqual([c.id, d.id].sort());
    expect(r.missing).toEqual([b.id]);
  });

  it('applies nothing without the genesis', () => {
    const r = fixedOrder([a, b, c]);
    expect(r.order).toEqual([]);
    expect(r.missing).toEqual([g.id]);
    expect(r.stateHash).toBe(stateHash([]));
  });

  it('keeps the genesis with the smallest id and ignores another one and its descendants', () => {
    const g2 = ev([], { salt: 'genesis 2' });
    const [win, lose] = [g, g2].sort((x, y) => (x.id < y.id ? -1 : 1)) as [TestEvent, TestEvent];
    const onLoser = ev([lose.id], { salt: 'on loser' });
    const onBoth = ev([win.id, lose.id], { salt: 'on both' });
    const onWinner = ev([win.id], { salt: 'on winner' });
    const r = fixedOrder([onBoth, lose, onLoser, win, onWinner]);
    expect(ids(r.order)).toEqual([win.id, onWinner.id]);
    expect(ids(r.ignored).sort()).toEqual([lose.id, onLoser.id, onBoth.id].sort());
    expect(r.waiting).toEqual([]);
  });

  it('accepts the same event twice, refuses two events with one id', () => {
    expect(ids(fixedOrder([g, a, a]).order)).toEqual([g.id, a.id]);
    expect(() => fixedOrder([g, a, { ...a, parents: [b.id] }])).toThrow(OrderError);
  });

  it('ignores created_at, even when it lies', () => {
    const old = ev([g.id], { salt: 'x', createdAt: 0 });
    const future = ev([old.id], { salt: 'y', createdAt: 4_000_000_000 });
    const past = ev([future.id], { salt: 'z', createdAt: 1 });
    expect(ids(fixedOrder([past, future, old, g]).order)).toEqual([
      g.id,
      old.id,
      future.id,
      past.id,
    ]);
  });

  it('never applies a cycle of unverified ids', () => {
    const x = { id: '1'.repeat(64), parents: ['2'.repeat(64)] };
    const y = { id: '2'.repeat(64), parents: ['1'.repeat(64)] };
    const r = fixedOrder([g, x, y]);
    expect(ids(r.order)).toEqual([g.id]);
    expect(ids(r.waiting)).toEqual([x.id, y.id]);
  });
});

describe('Causality', () => {
  const g = ev([], { salt: 'g' });
  const a = ev([g.id], { salt: 'a' });
  const b = ev([g.id], { salt: 'b' });
  const c = ev([a.id], { salt: 'c' });
  const d = ev([b.id, c.id], { salt: 'd' });
  const { causality } = fixedOrder([g, a, b, c, d]);

  it('precedes is the transitive closure of the parents', () => {
    expect(causality.precedes(g.id, d.id)).toBe(true);
    expect(causality.precedes(a.id, d.id)).toBe(true);
    expect(causality.precedes(a.id, c.id)).toBe(true);
    expect(causality.precedes(c.id, a.id)).toBe(false);
    expect(causality.precedes(a.id, a.id)).toBe(false);
  });

  it('concurrent = neither precedes the other', () => {
    expect(causality.concurrent(a.id, b.id)).toBe(true);
    expect(causality.concurrent(c.id, b.id)).toBe(true);
    expect(causality.concurrent(a.id, c.id)).toBe(false);
    expect(causality.concurrent(a.id, a.id)).toBe(false);
  });

  it('ancestorsOf lists what the author knew, in the fixed order', () => {
    expect(causality.ancestorsOf(c.id)).toEqual([g.id, a.id]);
    expect(new Set(causality.ancestorsOf(d.id))).toEqual(new Set([g.id, a.id, b.id, c.id]));
    expect(causality.ancestorsOf(g.id)).toEqual([]);
  });

  it('maxima keeps the causally latest', () => {
    expect(causality.maxima([a.id, c.id])).toEqual([c.id]);
    expect(causality.maxima([a.id, b.id]).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses events that are not applied', () => {
    expect(() => causality.precedes('9'.repeat(64), a.id)).toThrow(OrderError);
  });
});

// Plan §12 task 8: at least 1,000 random DAGs.
const RUNS = { numRuns: 1000 };

describe('properties of the fixed order', () => {
  it('same set, any delivery order → same sequence and same stateHash', () => {
    fc.assert(
      fc.property(
        dag(),
        fc.array(fc.double({ noNaN: true }), { minLength: 41, maxLength: 41 }),
        (events, keys) => {
          const shuffled = events
            .map((e, i) => ({ e, k: keys[i] ?? 0 }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.e);
          const r1 = fixedOrder(events);
          const r2 = fixedOrder(shuffled);
          const r3 = fixedOrder([...events].reverse());
          expect(ids(r2.order)).toEqual(ids(r1.order));
          expect(ids(r3.order)).toEqual(ids(r1.order));
          expect(r2.stateHash).toBe(r1.stateHash);
          expect(r2.frontier).toEqual(r1.frontier);
          expect(ids(r1.order)).toEqual(referenceOrder(events));
          expect(r1.order).toHaveLength(new Set(ids(events)).size);
        },
      ),
      RUNS,
    );
  });

  it('every event comes after all its parents, whatever its created_at says', () => {
    fc.assert(
      fc.property(dag(), (events) => {
        const { order } = fixedOrder(events);
        const pos = new Map(order.map((e, i) => [e.id, i]));
        for (const e of order)
          for (const p of e.parents)
            expect(pos.get(p) as number).toBeLessThan(pos.get(e.id) as number);
      }),
      RUNS,
    );
  });

  it('created_at has no effect on the order', () => {
    fc.assert(
      fc.property(dag(), fc.integer({ min: 0, max: 4_000_000_000 }), (events, fake) => {
        const lied = events.map((e, i) => ({ ...e, created_at: i % 2 === 0 ? fake : -fake }));
        const byTime = [...events].sort((a, b) => b.created_at - a.created_at);
        expect(ids(fixedOrder(lied).order)).toEqual(ids(fixedOrder(events).order));
        expect(ids(fixedOrder(byTime).order)).toEqual(ids(fixedOrder(events).order));
      }),
      RUNS,
    );
  });

  it('an event with a missing ancestor is never applied', () => {
    fc.assert(
      fc.property(
        dag(),
        fc.nat(),
        fc.array(fc.double({ noNaN: true }), { minLength: 41, maxLength: 41 }),
        (events, pick, keys) => {
          fc.pre(events.length > 1);
          const dropped = events[1 + (pick % (events.length - 1))] as TestEvent;
          const kept = events
            .filter((e) => e.id !== dropped.id)
            .map((e, i) => ({ e, k: keys[i] ?? 0 }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.e);
          const r = fixedOrder(kept);
          const blocked = descendants(events, dropped.id);
          for (const e of r.order) expect(blocked.has(e.id)).toBe(false);
          expect(new Set(ids(r.waiting))).toEqual(blocked);
          // Cited by someone → to fetch; a dropped leaf is simply unknown.
          expect(r.missing.includes(dropped.id)).toBe(blocked.size > 0);
          expect(r.order).toHaveLength(kept.length - blocked.size);
          expect(ids(r.order)).toEqual(referenceOrder(kept));
        },
      ),
      RUNS,
    );
  });

  it('precedes agrees with a walk of the parents', () => {
    fc.assert(
      fc.property(dag(20), fc.nat(), fc.nat(), (events, i, j) => {
        const { causality } = fixedOrder(events);
        const x = events[i % events.length] as TestEvent;
        const y = events[j % events.length] as TestEvent;
        const walk = descendants(events, x.id).has(y.id);
        expect(causality.precedes(x.id, y.id)).toBe(walk);
      }),
      RUNS,
    );
  });
});
