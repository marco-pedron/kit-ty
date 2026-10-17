import {
  GENESIS_HASH,
  StoredEventSchema,
  storedEventHash,
  type SignedEvent,
  type StoredEvent,
} from '@kitty/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { rateSet, tripCreated } from '../../../relay/src/test/helpers.js';
import { createSseParser, subscribeStream, type SseFrame, type StreamDeps } from './sse.js';
import type { RelayStatus } from './types.js';

// Stream failures the real relay does not produce on demand: a gap in seq, a malformed event,
// a silent connection, a failing handler. The relay is replaced by a scripted fetch.

function chain(signed: SignedEvent[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  for (const s of signed) {
    const seq = out.length + 1;
    const prevHash = out.at(-1)?.hash ?? GENESIS_HASH;
    out.push({
      seq,
      prevHash,
      signed: s,
      receivedAt: '2026-10-17T12:00:00.000Z',
      hash: storedEventHash({ seq, prevHash, signed: s }),
    });
  }
  return out;
}
const events = chain([tripCreated(), rateSet(), rateSet(), rateSet()]);
const frame = (e: StoredEvent) =>
  `id: ${e.seq}\nevent: stored\ndata: ${JSON.stringify(z.encode(StoredEventSchema, e))}\n\n`;

/** Each /events/stream call takes the next script: chunks to send, then stay open or close. */
type Script = { chunks: string[]; close?: boolean };
function scriptedFetch(scripts: Script[]) {
  const urls: string[] = [];
  const fetch: StreamDeps['fetch'] = async (url, init) => {
    urls.push(url);
    const script = scripts.shift();
    if (script === undefined) throw new TypeError('fetch failed');
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of script.chunks) ctrl.enqueue(new TextEncoder().encode(c));
        if (script.close) ctrl.close();
        init?.signal?.addEventListener('abort', () => ctrl.error(init.signal?.reason));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, urls };
}

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

function run(
  fetch: StreamDeps['fetch'],
  list: StreamDeps['list'] = async () => [],
  idleTimeoutMs = 5_000,
) {
  const seqs: number[] = [];
  const statuses: RelayStatus[] = [];
  stops.push(
    subscribeStream(
      { baseUrl: 'http://relay', fetch, list, backoff: { initialMs: 5, maxMs: 20 }, idleTimeoutMs },
      (e) => seqs.push(e.seq),
      { onStatus: (s) => statuses.push(s) },
    ),
  );
  return { seqs, statuses };
}

async function waitFor(cond: () => boolean, what: string) {
  await vi.waitFor(() => {
    if (!cond()) throw new Error(`still waiting for ${what}`);
  });
}

describe('createSseParser', () => {
  it('handles frames split across chunks, CRLF, comments, multi-line data and defaults', () => {
    const frames: SseFrame[] = [];
    const feed = createSseParser((f) => frames.push(f));
    feed(': connected\r\n\r\nid: 1\r\nevent: sto');
    feed('red\r\ndata: {"a":\r\ndata: 1}\r\n');
    feed('\r\ndata:plain\n\n: heartbeat\n\nevent: empty\n\n');
    expect(frames).toEqual([
      { id: '1', event: 'stored', data: '{"a":\n1}' },
      { id: null, event: 'message', data: 'plain' },
    ]);
  });
});

describe('subscribeStream', () => {
  it('fills a gap in the stream from list(last), in order', async () => {
    const [e1, , e3] = events;
    const { fetch } = scriptedFetch([{ chunks: [frame(e1!), frame(e3!)] }]);
    const list = vi.fn(async (since: number) => events.filter((e) => e.seq > since));
    const { seqs } = run(fetch, list);
    await waitFor(() => seqs.length === 3, 'three events');
    expect(seqs).toEqual([1, 2, 3]);
    expect(list).toHaveBeenCalledWith(1);
  });

  it('drops duplicates and resumes from the last seq after the stream closes', async () => {
    const [e1, e2, e3] = events;
    const { fetch, urls } = scriptedFetch([
      { chunks: [frame(e1!), frame(e2!)], close: true },
      { chunks: [frame(e2!), frame(e3!)] },
    ]);
    const { seqs, statuses } = run(fetch);
    await waitFor(() => seqs.length === 3, 'three events');
    expect(seqs).toEqual([1, 2, 3]);
    expect(urls).toEqual([
      'http://relay/events/stream?since=0',
      'http://relay/events/stream?since=2',
    ]);
    expect(statuses.map((s) => s.state)).toEqual(['connected', 'reconnecting', 'connected']);
  });

  it('never skips a malformed event: it reconnects and reports a relay fault', async () => {
    const [e1, e2] = events;
    const { fetch, urls } = scriptedFetch([
      { chunks: [frame(e1!), 'id: 2\nevent: stored\ndata: {"seq":2}\n\n'] },
      { chunks: [frame(e2!)] },
    ]);
    const { seqs, statuses } = run(fetch);
    await waitFor(() => seqs.length === 2, 'two events');
    expect(urls.at(-1)).toBe('http://relay/events/stream?since=1');
    const fault = statuses.find((s) => s.state === 'reconnecting');
    expect(fault).toMatchObject({
      error: { code: 'INTERNAL', message: expect.stringMatching(/malformed/) },
    });
  });

  it('reconnects when the stream goes silent', async () => {
    const [e1] = events;
    const { fetch } = scriptedFetch([{ chunks: [] }, { chunks: [frame(e1!)] }]);
    const { seqs, statuses } = run(fetch, undefined, 50);
    await waitFor(() => seqs.length === 1, 'event after reconnect');
    expect(statuses.find((s) => s.state === 'reconnecting')).toMatchObject({
      error: { code: 'RELAY_UNREACHABLE', message: 'relay stream went silent' },
    });
  });

  it('backs off exponentially up to maxMs while the relay is down', async () => {
    const { fetch } = scriptedFetch([]);
    const { statuses } = run(fetch);
    await waitFor(() => statuses.length >= 4, 'four retries');
    const delays = statuses.map((s) => (s.state === 'reconnecting' ? s.retryInMs : -1));
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 20]);
    expect(statuses[0]).toMatchObject({ error: { code: 'RELAY_UNREACHABLE' } });
  });

  it('keeps delivering when the handler throws', async () => {
    const [e1, e2] = events;
    const { fetch } = scriptedFetch([{ chunks: [frame(e1!), frame(e2!)] }]);
    const seqs: number[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stops.push(
      subscribeStream(
        {
          baseUrl: 'http://relay',
          fetch,
          list: async () => [],
          backoff: { initialMs: 5, maxMs: 20 },
          idleTimeoutMs: 5_000,
        },
        (e) => {
          seqs.push(e.seq);
          if (e.seq === 1) throw new Error('handler bug');
        },
      ),
    );
    await waitFor(() => seqs.length === 2, 'both events');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
