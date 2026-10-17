import Fastify, { type FastifyInstance } from 'fastify';

// The relay ("postino", SPEC §5, §9): receives, validates, orders and delivers signed events.
// Skeleton only; events, SSE and backups are task C1.
export function buildRelay(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.get('/health', async () => ({ ok: true, service: 'relay' }));
  return app;
}
