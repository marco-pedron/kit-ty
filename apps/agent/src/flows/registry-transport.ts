import { KIND_REGISTRY, type NostrEvent } from '@kitty/shared';

// How registry v2 events travel between phones (plan §0bis.5: publish, query; subscribe and
// fetchMissing with step 4). The registry does not know what is underneath: step 4 puts 2-3
// Nostr relays here. Until then MemoryTransport stands in for them inside the agent process,
// where the four agents of the demo run (SPEC §14): nothing is persisted, and every agent still
// verifies every event itself.

/** A Nostr-style filter: the events of a trip tag (#T), or of some authors. */
export interface RegistryFilter {
  tripTag?: string;
  authors?: readonly string[];
}

export interface RegistryTransport {
  publish(e: NostrEvent): Promise<void>;
  query(f: RegistryFilter): Promise<readonly NostrEvent[]>;
}

export class MemoryTransport implements RegistryTransport {
  private readonly events = new Map<string, NostrEvent>();

  publish(e: NostrEvent): Promise<void> {
    if (e.kind === KIND_REGISTRY && !this.events.has(e.id)) this.events.set(e.id, e);
    return Promise.resolve();
  }

  query(f: RegistryFilter): Promise<readonly NostrEvent[]> {
    return Promise.resolve(
      [...this.events.values()].filter(
        (e) =>
          (f.authors === undefined || f.authors.includes(e.pubkey)) &&
          (f.tripTag === undefined || e.tags.some((t) => t[0] === 'T' && t[1] === f.tripTag)),
      ),
    );
  }
}
