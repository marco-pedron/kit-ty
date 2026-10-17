// OWNED BY STREAM C (PLAN.md §2): the real client is task C2. Interface from SPEC §14.2.
// Nothing coming from the relay is trusted: the agent re-validates every event (SPEC §9.3).
import type { SignedEvent, StoredEvent } from '@kitty/shared';

export interface RelayClient {
  append(e: SignedEvent): Promise<StoredEvent>;
  list(sinceSeq?: number): Promise<StoredEvent[]>;
  /** SSE with reconnection and catch-up from the last seq; returns unsubscribe. */
  subscribe(onEvent: (e: StoredEvent) => void): () => void;
  /** Opaque encrypted blob (SPEC §12); the relay cannot read it. */
  putBackup(pubkey: string, blob: Uint8Array): Promise<void>;
  getBackup(pubkey: string): Promise<Uint8Array | null>;
}
