import type { ValidationDeps } from '@kitty/ledger';
import {
  apiError,
  PubkeySchema,
  signatureVerifier,
  StoredEventSchema,
  type ApiError,
  type ApiErrorBody,
} from '@kitty/shared';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { decodeBolt11 } from './bolt11.js';
import { openRelayDb, type RelayDb } from './db.js';
import { createEventLog, type Validate } from './log.js';
import { serveStream } from './sse.js';

// The relay ("postino", SPEC §5, §9): receives, validates, orders and delivers signed events,
// and keeps encrypted backups it cannot read (SPEC §12). It holds no private key.

export interface RelayOptions {
  /** Default: an in-memory database. */
  db?: RelayDb;
  /** Default: the ledger's validateEvent. Tests inject a fake one. */
  validate?: Validate;
  /** Default: the real ed25519 verifier and the JS BOLT11 decoder. */
  deps?: ValidationDeps;
  now?: () => Date;
  /** Largest backup accepted, in bytes (a RLN backup is ≈440 KB, SPEC §12). */
  maxBackupBytes?: number;
  heartbeatMs?: number;
  logger?: boolean;
}

export const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 * 1024;

export const defaultDeps: ValidationDeps = {
  verify: signatureVerifier,
  decodeInvoice: decodeBolt11,
};

const SinceSchema = z.coerce.number().int().nonnegative().default(0);
const PubkeyParams = z.object({ pubkey: PubkeySchema });

function sendError(reply: FastifyReply, status: number, error: ApiError) {
  const body: ApiErrorBody = { error };
  return reply.code(status).send(body);
}

export function buildRelay(opts: RelayOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // On shutdown, drop every connection: after an SSE client aborts, undici opens a fresh
    // keep-alive socket with no request, which 'idle' does not close, so close() would wait
    // for the client's own 4 s timeout. Agents reconnect and catch up by themselves.
    forceCloseConnections: true,
  });
  const db = opts.db ?? openRelayDb(':memory:');
  const log = createEventLog({
    db,
    deps: opts.deps ?? defaultDeps,
    ...(opts.validate && { validate: opts.validate }),
    ...(opts.now && { now: opts.now }),
  });
  const now = opts.now ?? (() => new Date());
  const maxBackupBytes = opts.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES;

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: maxBackupBytes },
    (_req, body, done) => done(null, body),
  );

  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    if (err.statusCode === 413) {
      return sendError(
        reply,
        413,
        apiError(
          'VALIDATION_ERROR',
          `body larger than ${maxBackupBytes} bytes`,
          'The backup is too large for the relay. Report it to the coordinator.',
        ),
      );
    }
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      return sendError(reply, err.statusCode, apiError('VALIDATION_ERROR', err.message));
    }
    app.log.error(err);
    return sendError(reply, 500, apiError('INTERNAL', 'relay error'));
  });

  // Open SSE streams would keep app.close() waiting forever.
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of streams) end();
  });

  app.get('/health', async () => ({ ok: true, service: 'relay' }));

  app.post('/events', async (req, reply) => {
    const r = log.append(req.body);
    if (!r.ok) return sendError(reply, r.status, r.error);
    return reply.code(201).send(z.encode(StoredEventSchema, r.stored));
  });

  app.get('/events', async (req, reply) => {
    const since = SinceSchema.safeParse((req.query as { since?: unknown }).since);
    if (!since.success) return sendError(reply, 400, apiError('VALIDATION_ERROR', 'bad since'));
    // Straight from storage: already in wire form.
    const body = `[${log
      .listEncoded(since.data)
      .map((e) => e.json)
      .join(',')}]`;
    return reply.type('application/json').send(body);
  });

  app.get('/events/stream', (req, reply) => {
    const q = (req.query as { since?: unknown }).since ?? req.headers['last-event-id'];
    const since = SinceSchema.safeParse(q);
    if (!since.success) return sendError(reply, 400, apiError('VALIDATION_ERROR', 'bad since'));
    const end = serveStream(req, reply, log, since.data, opts.heartbeatMs);
    streams.add(end);
    req.raw.on('close', () => streams.delete(end));
  });

  app.put('/backups/:pubkey', async (req, reply) => {
    const params = PubkeyParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, apiError('VALIDATION_ERROR', 'bad pubkey'));
    if (!(req.body instanceof Buffer) || req.body.length === 0) {
      return sendError(
        reply,
        400,
        apiError('VALIDATION_ERROR', 'expected a non-empty application/octet-stream body'),
      );
    }
    const version = db.putBackup(params.data.pubkey, req.body, now().toISOString());
    return reply.code(201).send({ version });
  });

  app.get('/backups/:pubkey', async (req, reply) => {
    const params = PubkeyParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, apiError('VALIDATION_ERROR', 'bad pubkey'));
    const b = db.latestBackup(params.data.pubkey);
    if (b === null) return sendError(reply, 404, apiError('NOT_FOUND', 'no backup for this key'));
    return reply
      .type('application/octet-stream')
      .header('x-backup-version', String(b.version))
      .header('x-backup-created-at', b.createdAt)
      .send(Buffer.from(b.blob));
  });

  // An injected database belongs to the caller; ours is closed with the server.
  if (opts.db === undefined) app.addHook('onClose', async () => db.close());
  return app;
}
