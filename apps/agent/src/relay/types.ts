// OWNED BY STREAM C (PLAN.md §2). Interface from SPEC §14.2; the real client is http-client.ts.
// Nothing coming from the relay is trusted: the agent re-validates every event (SPEC §9.3).
import type { SignedEvent, StoredEvent } from '@kitty/shared';
import type { RelayError } from './errors.js';

/** Connection state of a subscription, for the UI (task C7: "Cannot reach the trip relay…"). */
export type RelayStatus =
  | { state: 'connected' }
  | { state: 'reconnecting'; attempt: number; retryInMs: number; error: RelayError };

export interface SubscribeOptions {
  /** Deliver only events after this seq (e.g. the last one already fetched with list). Default 0. */
  sinceSeq?: number;
  onStatus?: (status: RelayStatus) => void;
}

export interface RelayClient {
  append(e: SignedEvent): Promise<StoredEvent>;
  list(sinceSeq?: number): Promise<StoredEvent[]>;
  /**
   * SSE with reconnection and catch-up from the last seq; returns unsubscribe. Events arrive
   * once each, in seq order with no gaps.
   */
  subscribe(onEvent: (e: StoredEvent) => void, opts?: SubscribeOptions): () => void;
  /** Opaque encrypted blob (SPEC §12); the relay cannot read it. */
  putBackup(pubkey: string, blob: Uint8Array): Promise<void>;
  getBackup(pubkey: string): Promise<Uint8Array | null>;
}
