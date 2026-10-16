import {
  ActorIdSchema,
  ERROR_ACTIONS,
  TripViewSchema,
  apiError,
  routes,
  type ActorId,
  type ApiErrorBody,
} from '@kitty/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Agent } from './agent.js';
import type { Config } from './config.js';
import { createFakeAi } from './dev-fakes/fake-ai.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { FAKES_BANNER } from './dev-fakes/guard.js';
import { emptyTripView } from './routes/state.js';

export function buildAgents(config: Config): Map<ActorId, Agent> {
  const agents = new Map<ActorId, Agent>();
  // Fakes: one in-memory network and one fake AI, shared like the real node network and QVAC.
  const net = config.KITTY_FAKES ? new FakeLightningNetwork() : null;
  const ai = config.KITTY_FAKES ? createFakeAi() : null;
  for (const actor of ActorIdSchema.options) {
    agents.set(actor, new Agent(actor, net?.wallet(actor) ?? null, actor === 'dave' ? null : ai));
  }
  return agents;
}

export function buildAgentServer(
  config: Config,
  now: () => Date = () => new Date(),
): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const agents = buildAgents(config);
  if (config.KITTY_FAKES) app.log.warn(FAKES_BANNER);

  const fail = (code: Parameters<typeof apiError>[0], message: string): ApiErrorBody => ({
    error: apiError(code, message),
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(fail('NOT_FOUND', `${req.method} ${req.url}`));
  });
  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    void reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        action: ERROR_ACTIONS.INTERNAL,
      },
    });
  });

  app.get('/health', async () => ({ ok: true, service: 'agent', fakes: config.KITTY_FAKES }));

  app.get(routes.getState.path, async (req, reply) => {
    const params = routes.getState.params.safeParse(req.params);
    if (!params.success) return reply.code(404).send(fail('NOT_FOUND', 'unknown member'));
    const agent = agents.get(params.data.as);
    if (!agent) return reply.code(404).send(fail('NOT_FOUND', 'unknown member'));
    const view = emptyTripView(agent, {
      fakes: config.KITTY_FAKES,
      explorerBaseUrl: config.ESPLORA_URL,
      now: now(),
    });
    return z.encode(TripViewSchema, view);
  });

  return app;
}
