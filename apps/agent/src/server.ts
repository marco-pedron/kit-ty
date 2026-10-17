import { ERROR_ACTIONS, apiError, type ApiErrorBody } from '@kitty/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AiService } from './ai/types.js';
import type { Config } from './config.js';
import { createFakeAi } from './dev-fakes/fake-ai.js';
import { FAKES_BANNER } from './dev-fakes/guard.js';
import type { AgentRuntime } from './flows/runtime.js';
import { registerRoutes } from './routes/index.js';

// The agent's HTTP server (SPEC §14.3). It does not build agents or wallets: index.ts builds
// the server, then the runtime (startAgents, A5, which logs with app.log), then listens; the
// routes read the runtime through a getter.

export interface AgentServerDeps {
  /** The runtime of startAgents (A5). Default: none, the agent routes answer 503. */
  runtime?: () => AgentRuntime | null;
  /** The travelers' on-device AI (A4). Default: the FakeAi with KITTY_FAKES=1, else none. */
  ai?: AiService | null;
  now?: () => Date;
  /** Proof panel, on-chain rail. Default: GET <ESPLORA_URL>/tx/<txid>. */
  onchainFound?: (txid: string) => Promise<boolean>;
}

export function buildAgentServer(config: Config, deps: AgentServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
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

  const esplora = config.ESPLORA_URL.replace(/\/+$/, '');
  registerRoutes(app, {
    runtime: deps.runtime ?? (() => null),
    ai: deps.ai !== undefined ? deps.ai : config.KITTY_FAKES ? createFakeAi() : null,
    fakes: config.KITTY_FAKES,
    explorerBaseUrl: config.ESPLORA_URL,
    now: deps.now ?? (() => new Date()),
    onchainFound:
      deps.onchainFound ??
      (async (txid) =>
        (await fetch(`${esplora}/tx/${txid}`, { signal: AbortSignal.timeout(3_000) })).ok),
  });

  return app;
}
