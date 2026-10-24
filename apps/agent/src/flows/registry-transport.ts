import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { KIND_REGISTRY, type NostrEvent } from '@kitty/shared';

// How registry v2 events travel between phones (plan §0bis.5, step 4): publish, subscribe,
// fetchMissing, and query for the recovery from the seed. The registry does not know what is
// underneath: Nostr relays (relay/nostr-transport.ts, stream C) in the demo, MemoryTransport in
// the tests. Every event that arrives is still verified by the registry itself.

/** A Nostr-style filter: the events of a trip tag (#T), of some authors, or some ids. */
export interface RegistryFilter {
  tripTag?: string;
  authors?: readonly string[];
  ids?: readonly string[];
}

export interface RegistryTransport {
  /** To every relay; never throws for a relay that is down (it gets the event when back). */
  publish(e: NostrEvent): Promise<void>;
  /** The stored events matching `f`, from every relay that answers, without duplicates. */
  query(f: RegistryFilter): Promise<readonly NostrEvent[]>;
  /** Stored events first, then live ones; kept across reconnections. Returns the unsubscribe. */
  subscribe(f: RegistryFilter, onEvent: (e: NostrEvent) => void): () => void;
  /** The events with these ids, asked to every relay: parents a phone does not have yet. */
  fetchMissing(ids: readonly string[]): Promise<readonly NostrEvent[]>;
  close?(): void;
}

export function matches(f: RegistryFilter, e: NostrEvent): boolean {
  return (
    e.kind === KIND_REGISTRY &&
    (f.authors === undefined || f.authors.includes(e.pubkey)) &&
    (f.ids === undefined || f.ids.includes(e.id)) &&
    (f.tripTag === undefined || e.tags.some((t) => t[0] === 'T' && t[1] === f.tripTag))
  );
}

/** One in-process relay (tests, KITTY_FAKES=1): every subscriber sees every event at once. */
export class MemoryTransport implements RegistryTransport {
  private readonly events = new Map<string, NostrEvent>();
  private readonly subs = new Set<{ f: RegistryFilter; on: (e: NostrEvent) => void }>();

  publish(e: NostrEvent): Promise<void> {
    if (e.kind === KIND_REGISTRY && !this.events.has(e.id)) {
      this.events.set(e.id, e);
      for (const s of this.subs) if (matches(s.f, e)) s.on(e);
    }
    return Promise.resolve();
  }

  query(f: RegistryFilter): Promise<readonly NostrEvent[]> {
    return Promise.resolve([...this.events.values()].filter((e) => matches(f, e)));
  }

  subscribe(f: RegistryFilter, on: (e: NostrEvent) => void): () => void {
    const sub = { f, on };
    this.subs.add(sub);
    for (const e of this.events.values()) if (matches(f, e)) on(e);
    return () => this.subs.delete(sub);
  }

  fetchMissing(ids: readonly string[]): Promise<readonly NostrEvent[]> {
    return this.query({ ids });
  }

  /** Tests: forget an event, as a relay that lost it. */
  drop(id: string): void {
    this.events.delete(id);
  }
}

/**
 * The complete local copy of a phone (step 4): every event of its trips as received, still
 * encrypted, so a restart does not start from zero and recovery works offline. Append-only.
 */
export interface RegistryStore {
  load(): NostrEvent[];
  add(e: NostrEvent): void;
}

export class MemoryStore implements RegistryStore {
  readonly events: NostrEvent[] = [];
  load(): NostrEvent[] {
    return [...this.events];
  }
  add(e: NostrEvent): void {
    this.events.push(e);
  }
}

/** One JSON event per line in `file` (infra/data/registry/<member>.jsonl in the demo). */
export class FileStore implements RegistryStore {
  constructor(private readonly file: string) {}

  load(): NostrEvent[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: NostrEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as NostrEvent);
      } catch {
        // a line cut by a crash: the event comes back from the relays
      }
    }
    return out;
  }

  add(e: NostrEvent): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(e)}\n`);
  }

  /** demo:lose-phone: the phone and its copy are gone. */
  wipe(): void {
    rmSync(this.file, { force: true });
  }
}
