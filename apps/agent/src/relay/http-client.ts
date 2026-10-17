import {
  ApiErrorBodySchema,
  SignedEventSchema,
  StoredEventSchema,
  type SignedEvent,
  type StoredEvent,
} from '@kitty/shared';
import { z } from 'zod';
import { RelayError } from './errors.js';
import { describe, subscribeStream } from './sse.js';
import type { RelayClient } from './types.js';

// The real RelayClient (task C2) over the relay's HTTP API (apps/relay/src/server.ts):
// POST /events, GET /events?since=, GET /events/stream (SSE), PUT/GET /backups/:pubkey.
// It checks only the shape of what comes back (zod); signatures, chain and rules are checked
// by the agent with the ledger's validateEvent, because nobody trusts the relay (SPEC §9.3).

export interface RelayClientOptions {
  /** e.g. config.RELAY_URL, http://127.0.0.1:4000 */
  baseUrl: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Per request, except the SSE stream. Default 10 s. */
  timeoutMs?: number;
  /** Reconnection delay of the SSE stream: doubles from initialMs up to maxMs. */
  backoff?: { initialMs: number; maxMs: number };
  /** SSE: silence after which the stream is considered dead. Default 45 s (3 heartbeats). */
  idleTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF = { initialMs: 250, maxMs: 5_000 };
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

const StoredEventListSchema = z.array(StoredEventSchema);

export function createRelayClient(opts: RelayClientOptions): RelayClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RelayError('RELAY_UNREACHABLE', `cannot reach the relay: ${describe(err)}`);
    }
    if (res.ok) return res;
    // The relay always answers errors with an ApiErrorBody; anything else is a proxy or a bug.
    const body = ApiErrorBodySchema.safeParse(await res.json().catch(() => undefined));
    if (body.success) {
      const { code, message, action } = body.data.error;
      throw new RelayError(code, message, action, res.status);
    }
    throw new RelayError(
      'RELAY_UNREACHABLE',
      `relay answered HTTP ${res.status}`,
      undefined,
      res.status,
    );
  }

  async function json<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new RelayError('INTERNAL', `relay sent a malformed ${what}`);
    return parsed.data;
  }

  const list = async (sinceSeq = 0): Promise<StoredEvent[]> =>
    json(await request(`/events?since=${sinceSeq}`), StoredEventListSchema, 'event list');

  return {
    async append(e: SignedEvent) {
      const res = await request('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(z.encode(SignedEventSchema, e)),
      });
      return json(res, StoredEventSchema, 'stored event');
    },

    list,

    subscribe(onEvent, subscribeOpts) {
      return subscribeStream(
        {
          baseUrl,
          fetch: fetchImpl,
          list,
          backoff: opts.backoff ?? DEFAULT_BACKOFF,
          idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        },
        onEvent,
        subscribeOpts,
      );
    },

    async putBackup(pubkey, blob) {
      await request(`/backups/${encodeURIComponent(pubkey)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        // A copy: fetch wants an ArrayBuffer-backed view, the caller may pass any Uint8Array.
        body: new Uint8Array(blob),
      });
    },

    async getBackup(pubkey) {
      try {
        const res = await request(`/backups/${encodeURIComponent(pubkey)}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof RelayError && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },
  };
}
