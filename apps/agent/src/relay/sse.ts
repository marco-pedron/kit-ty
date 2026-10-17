import { StoredEventSchema, type StoredEvent } from '@kitty/shared';
import { RelayError } from './errors.js';
import type { RelayStatus, SubscribeOptions } from './types.js';

// The relay's SSE stream (GET /events/stream?since=N, apps/relay/src/sse.ts), read with fetch:
// Node 22 has no global EventSource. The subscription keeps `last`, the highest seq delivered,
// and on any failure reconnects from there with exponential backoff, so the agent gets every
// event once, in seq order. A gap in the stream is filled with list(last) before going on.
// A malformed event is a relay fault: it is never skipped, the stream reconnects instead.

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental parser of text/event-stream (WHATWG HTML §9.2), enough for the relay. */
export function createSseParser(onFrame: (f: SseFrame) => void): (chunk: string) => void {
  let buf = '';
  let id: string | null = null;
  let event = '';
  let data: string[] = [];
  return (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r\n|\r|\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        if (data.length > 0) onFrame({ id, event: event || 'message', data: data.join('\n') });
        id = null;
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
    }
  };
}

export interface StreamDeps {
  baseUrl: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  list: (sinceSeq: number) => Promise<StoredEvent[]>;
  backoff: { initialMs: number; maxMs: number };
  /** No byte for this long (the relay sends a heartbeat every 15 s) → reconnect. */
  idleTimeoutMs: number;
}

export function subscribeStream(
  deps: StreamDeps,
  onEvent: (e: StoredEvent) => void,
  opts: SubscribeOptions = {},
): () => void {
  let last = opts.sinceSeq ?? 0;
  let stopped = false;
  let current: AbortController | null = null;
  let wake: (() => void) | null = null;

  const deliver = (e: StoredEvent) => {
    if (e.seq !== last + 1) return;
    last = e.seq;
    try {
      onEvent(e);
    } catch (err) {
      // The handler's bugs must not stop the log; the agent rebuilds its state from list().
      console.error(`relay subscriber failed on seq ${e.seq}:`, err);
    }
  };

  /** Delivers `e`, first filling any gap before it from list(last). */
  const accept = async (e: StoredEvent) => {
    if (e.seq <= last) return;
    if (e.seq > last + 1) {
      for (const missing of await deps.list(last)) {
        if (missing.seq >= e.seq) break;
        deliver(missing);
      }
      if (e.seq !== last + 1)
        throw new RelayError('INTERNAL', `relay skipped events before ${e.seq}`);
    }
    deliver(e);
  };

  async function readOnce(ctrl: AbortController, onConnected: () => void): Promise<void> {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => ctrl.abort(new RelayError('RELAY_UNREACHABLE', 'relay stream went silent')),
        deps.idleTimeoutMs,
      );
    };
    try {
      arm();
      let res: Response;
      try {
        res = await deps.fetch(`${deps.baseUrl}/events/stream?since=${last}`, {
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
      } catch (err) {
        throw unreachable(err, ctrl);
      }
      if (!res.ok || res.body === null) {
        throw new RelayError(
          'RELAY_UNREACHABLE',
          `relay stream answered HTTP ${res.status}`,
          undefined,
          res.status,
        );
      }
      onConnected();
      // Frames are parsed synchronously but handled one at a time, in order.
      const pending: SseFrame[] = [];
      const parse = createSseParser((f) => pending.push(f));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<string>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw unreachable(err, ctrl);
        }
        if (chunk.done) throw new RelayError('RELAY_UNREACHABLE', 'relay closed the stream');
        arm();
        parse(chunk.value);
        while (pending.length > 0) {
          const f = pending.shift()!;
          if (f.event !== 'stored') continue;
          const parsed = safeJson(f.data);
          const e = StoredEventSchema.safeParse(parsed);
          if (!e.success)
            throw new RelayError('INTERNAL', `relay sent a malformed event (id ${f.id})`);
          await accept(e.data);
        }
      }
    } finally {
      clearTimeout(idle);
    }
  }

  void (async () => {
    let attempt = 0;
    while (!stopped) {
      const ctrl = new AbortController();
      current = ctrl;
      try {
        await readOnce(ctrl, () => {
          attempt = 0;
          opts.onStatus?.({ state: 'connected' });
        });
      } catch (err) {
        if (stopped) break;
        attempt += 1;
        const retryInMs = Math.min(deps.backoff.maxMs, deps.backoff.initialMs * 2 ** (attempt - 1));
        const error =
          err instanceof RelayError
            ? err
            : new RelayError('RELAY_UNREACHABLE', `relay stream failed: ${String(err)}`);
        const status: RelayStatus = { state: 'reconnecting', attempt, retryInMs, error };
        opts.onStatus?.(status);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, retryInMs);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
    }
  })();

  return () => {
    stopped = true;
    current?.abort();
    wake?.();
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** A network failure, or the idle timeout's own RelayError if that is what aborted it. */
function unreachable(err: unknown, ctrl: AbortController): RelayError {
  if (ctrl.signal.reason instanceof RelayError) return ctrl.signal.reason;
  return new RelayError('RELAY_UNREACHABLE', `cannot reach the relay: ${describe(err)}`);
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
