import { deriveTrip, LedgerError, type ValidationDeps, validateEvent } from '@kitty/ledger';
import {
  apiError,
  GENESIS_HASH,
  type ApiError,
  type SignedEvent,
  SignedEventSchema,
  type StoredEvent,
  StoredEventSchema,
  storedEventHash,
} from '@kitty/shared';
import { z } from 'zod';
import type { EventRow, RelayDb } from './db.js';

// The signed log (SPEC §9.1, §9.3). The relay wraps each SignedEvent in a StoredEvent
// (seq, prevHash, receivedAt, hash) and accepts it only if the ledger's validateEvent says so,
// against the trip derived from every previous event. One relay database = one trip = one chain.
// Append is fully synchronous: no await between reading the head and inserting, so two
// concurrent requests can never get the same seq.

export type Validate = typeof validateEvent;

export type AppendResult =
  { ok: true; stored: StoredEvent } | { ok: false; status: 400 | 409 | 501; error: ApiError };

export interface EventLog {
  append(signed: unknown): AppendResult;
  list(sinceSeq?: number): StoredEvent[];
  /** Wire form of the events after sinceSeq (bigints as strings), straight from storage. */
  listEncoded(sinceSeq?: number): { seq: number; json: string }[];
  /** Called after every accepted event, with the stored event and its wire JSON. */
  onAppend(listener: (stored: StoredEvent, json: string) => void): () => void;
}

export interface EventLogOptions {
  db: RelayDb;
  /** The ledger's validateEvent; tests inject a fake one. */
  validate?: Validate;
  deps: ValidationDeps;
  now?: () => Date;
}

const decode = (row: EventRow): StoredEvent => StoredEventSchema.parse(JSON.parse(row.storedJson));

export function createEventLog(opts: EventLogOptions): EventLog {
  const { db, deps } = opts;
  const validate = opts.validate ?? validateEvent;
  const now = opts.now ?? (() => new Date());
  const listeners = new Set<(stored: StoredEvent, json: string) => void>();

  function append(input: unknown): AppendResult {
    const parsed = SignedEventSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        error: apiError('VALIDATION_ERROR', `not a signed event: ${z.prettifyError(parsed.error)}`),
      };
    }
    const signed: SignedEvent = parsed.data;
    const previous = db.listEvents().map(decode);
    const head = previous.at(-1);
    const receivedAt = now();
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.hash ?? GENESIS_HASH;
    const stored: StoredEvent = {
      seq,
      prevHash,
      signed,
      receivedAt: receivedAt.toISOString(),
      hash: storedEventHash({ seq, prevHash, signed }),
    };

    // Structural checks the relay makes on its own, before the ledger rules: one trip per chain
    // and a nonce never seen (the UNIQUE constraint on nonce is the last line of defence).
    const first = previous[0];
    if (first !== undefined && signed.inner.tripId !== first.signed.inner.tripId) {
      return reject(409, `this relay serves trip ${first.signed.inner.tripId}`);
    }
    if (db.hasNonce(signed.inner.nonce)) return reject(409, 'nonce already used in this trip');

    let verdict;
    try {
      verdict = validate(stored, deriveTrip(previous, receivedAt), deps);
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'NOT_IMPLEMENTED') {
        return { ok: false, status: 501, error: apiError('NOT_IMPLEMENTED', e.message) };
      }
      if (e instanceof LedgerError) return reject(409, e.message);
      throw e;
    }
    if (!verdict.ok) return reject(409, verdict.reason);

    const json = JSON.stringify(z.encode(StoredEventSchema, stored));
    db.insertEvent({
      seq,
      tripId: signed.inner.tripId,
      nonce: signed.inner.nonce,
      type: signed.inner.type,
      author: signed.inner.author,
      prevHash,
      hash: stored.hash,
      receivedAt: stored.receivedAt,
      storedJson: json,
    });
    for (const l of listeners) l(stored, json);
    return { ok: true, stored };
  }

  return {
    append,
    list: (sinceSeq) => db.listEvents(sinceSeq).map(decode),
    listEncoded: (sinceSeq) =>
      db.listEvents(sinceSeq).map((r) => ({ seq: r.seq, json: r.storedJson })),
    onAppend(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function reject(status: 409, reason: string): AppendResult {
  return { ok: false, status, error: apiError('INVALID_EVENT', reason) };
}
