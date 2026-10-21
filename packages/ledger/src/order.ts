import { sha256Hex } from '@kitty/shared';
import { hexToBytes } from './hex.js';

// The fixed order of the registry (docs/ADR-001-formato-eventi.md §4). Pure: the result
// depends only on the set of events, never on arrival order, relay or created_at.
//
// - Closed set: an event is applied only if every parent is applied. The genesis is the
//   parentless event with the smallest id (TRIP_CREATED, ADR-001 §4.1); any other parentless
//   event, and everything that descends from it, is ignored.
// - Order: Kahn's algorithm on the parent graph; among the ready events, the smallest id.
//   One total tie-break on unique ids gives one sequence per graph.
// - No cycles: a parent is cited by its id, the hash of its content, so citing a later event
//   would need a sha256 preimage. Unverified input with a cycle just never gets applied.
//
// Ids must have been verified (nostr.ts hasValidId) before they get here.

export interface DagEvent {
  readonly id: string;
  readonly parents: readonly string[];
}

export class OrderError extends Error {
  override readonly name = 'OrderError';
}

export interface FixedOrder<E extends DagEvent> {
  /** The applied events in the fixed order: genesis first. */
  readonly order: readonly E[];
  /** Present but not applicable yet: some ancestor is missing. Sorted by id. */
  readonly waiting: readonly E[];
  /** Ids cited by present events but absent: what to fetch (plan §2.5). Sorted. */
  readonly missing: readonly string[];
  /** Never applicable: a second genesis or one of its descendants. Sorted by id. */
  readonly ignored: readonly E[];
  /** Applied events no applied event cites. Sorted. */
  readonly frontier: readonly string[];
  /** sha256(id₁ ‖ … ‖ idₙ) over the 32-byte ids of `order`, hex (CHECKPOINT.stateHash). */
  readonly stateHash: string;
  readonly causality: Causality;
}

export function fixedOrder<E extends DagEvent>(events: Iterable<E>): FixedOrder<E> {
  const byId = new Map<string, E>();
  for (const e of events) {
    const seen = byId.get(e.id);
    if (seen === undefined) byId.set(e.id, e);
    else if (!sameParents(seen.parents, e.parents))
      throw new OrderError(`two different events with id ${e.id}: ids not verified`);
  }

  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  let genesis: string | undefined;
  for (const e of byId.values()) {
    const parents = new Set(e.parents);
    remaining.set(e.id, parents.size);
    for (const p of parents) {
      const list = children.get(p);
      if (list === undefined) children.set(p, [e.id]);
      else list.push(e.id);
    }
    if (parents.size === 0 && (genesis === undefined || e.id < genesis)) genesis = e.id;
  }

  const order: E[] = [];
  const ready = new MinHeap();
  if (genesis !== undefined) ready.push(genesis);
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    order.push(byId.get(id) as E);
    for (const child of children.get(id) ?? []) {
      const left = (remaining.get(child) ?? 0) - 1;
      remaining.set(child, left);
      if (left === 0) ready.push(child);
    }
  }

  const applied = new Set(order.map((e) => e.id));
  const missing = new Set<string>();
  for (const e of byId.values()) for (const p of e.parents) if (!byId.has(p)) missing.add(p);

  // Not applied: ignored if it descends from another parentless event (it never will be),
  // else waiting for a missing ancestor.
  const tainted = new Set<string>();
  const queue = [...byId.values()].filter((e) => e.parents.length === 0 && e.id !== genesis);
  for (let e = queue.pop(); e !== undefined; e = queue.pop()) {
    if (tainted.has(e.id)) continue;
    tainted.add(e.id);
    for (const child of children.get(e.id) ?? []) queue.push(byId.get(child) as E);
  }
  const waiting: E[] = [];
  const ignored: E[] = [];
  for (const e of [...byId.values()].sort(byIdAsc)) {
    if (applied.has(e.id)) continue;
    (tainted.has(e.id) ? ignored : waiting).push(e);
  }

  const cited = new Set(order.flatMap((e) => e.parents));
  return {
    order,
    waiting,
    missing: [...missing].sort(),
    ignored,
    frontier: order
      .map((e) => e.id)
      .filter((id) => !cited.has(id))
      .sort(),
    stateHash: stateHash(order.map((e) => e.id)),
    causality: new Causality(order),
  };
}

/** sha256 of the concatenated 32-byte ids, hex. The empty sequence hashes the empty string. */
export function stateHash(ids: readonly string[]): string {
  const buf = new Uint8Array(ids.length * 32);
  ids.forEach((id, i) => buf.set(hexToBytes(id), i * 32));
  return sha256Hex(buf);
}

/**
 * "X precedes Y" on the applied events: X is an ancestor of Y (transitive closure of the
 * parents). The only relation conflict rules may use; the fixed order is for history and
 * for "first wins" cases where winning gives no advantage.
 */
export class Causality {
  private readonly index = new Map<string, number>();
  /** Bit i of ancestors[j] = the event at position i precedes the one at position j. */
  private readonly ancestors: bigint[] = [];

  constructor(order: readonly DagEvent[]) {
    order.forEach((e, i) => {
      let mask = 0n;
      for (const p of e.parents) {
        const j = this.index.get(p);
        if (j === undefined)
          throw new OrderError(`parent ${p} of ${e.id} comes later or is absent`);
        mask |= (this.ancestors[j] as bigint) | (1n << BigInt(j));
      }
      this.index.set(e.id, i);
      this.ancestors.push(mask);
    });
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Position in the fixed order. Throws on an event that is not applied. */
  position(id: string): number {
    const i = this.index.get(id);
    if (i === undefined) throw new OrderError(`event ${id} is not applied`);
    return i;
  }

  /** x is a strict ancestor of y. */
  precedes(x: string, y: string): boolean {
    const i = this.position(x);
    return ((this.ancestors[this.position(y)] as bigint) >> BigInt(i)) & 1n ? true : false;
  }

  /** Neither precedes the other (and they are different events). */
  concurrent(x: string, y: string): boolean {
    return x !== y && !this.precedes(x, y) && !this.precedes(y, x);
  }

  /** What the author of `id` knew when writing it: all its ancestors, in the fixed order. */
  ancestorsOf(id: string): string[] {
    const mask = this.ancestors[this.position(id)] as bigint;
    const out: string[] = [];
    for (const [other, i] of this.index) if ((mask >> BigInt(i)) & 1n) out.push(other);
    return out.sort((a, b) => this.position(a) - this.position(b));
  }

  /** Ids sorted by the fixed order. */
  sortByOrder(ids: readonly string[]): string[] {
    return [...ids].sort((a, b) => this.position(a) - this.position(b));
  }

  /** The events of `ids` that no other event of `ids` follows (the latest, causally). */
  maxima(ids: readonly string[]): string[] {
    return ids.filter((x) => !ids.some((y) => y !== x && this.precedes(x, y)));
  }
}

function sameParents(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

function byIdAsc(a: DagEvent, b: DagEvent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Binary min-heap of strings (ids): the smallest ready id in O(log n). */
class MinHeap {
  private readonly items: string[] = [];

  push(s: string): void {
    const a = this.items;
    a.push(s);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((a[parent] as string) <= s) break;
      a[i] = a[parent] as string;
      i = parent;
    }
    a[i] = s;
  }

  pop(): string | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined || a.length === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= a.length) break;
      const r = l + 1;
      const c = r < a.length && (a[r] as string) < (a[l] as string) ? r : l;
      if ((a[c] as string) >= last) break;
      a[i] = a[c] as string;
      i = c;
    }
    a[i] = last;
    return top;
  }
}
