import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventLog } from './log.js';

// GET /events/stream: Server-Sent Events. First every event after `since`, then each new one
// as it is accepted. `id:` is the seq, so a reconnecting EventSource sends Last-Event-ID and
// catches up from there. A comment every heartbeatMs keeps proxies from closing the stream.

export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Returns a function that ends the stream; the server calls it on close. */
export function serveStream(
  req: FastifyRequest,
  reply: FastifyReply,
  log: EventLog,
  since: number,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
): () => void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let last = since;
  const send = (seq: number, json: string) => {
    if (seq <= last) return;
    last = seq;
    res.write(`id: ${seq}\nevent: stored\ndata: ${json}\n\n`);
  };

  // Backlog and subscription with no await in between: appends are synchronous, so no event
  // can fall in the gap, and `last` drops any duplicate.
  for (const e of log.listEncoded(since)) send(e.seq, e.json);
  const off = log.onAppend((stored, json) => send(stored.seq, json));
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
  const end = () => {
    clearInterval(heartbeat);
    off();
    if (!res.writableEnded) res.end();
  };
  req.raw.on('close', end);
  return end;
}
