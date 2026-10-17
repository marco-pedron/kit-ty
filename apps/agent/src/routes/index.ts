// OWNED BY STREAM C (task C3): the agent API of SPEC §14.3, thin over the flows of A5.
// Every route: params and body parsed with the shared `routes` schemas, the role taken from the
// path (a traveler on a dave route, or dave on a traveler route → NOT_ALLOWED), the response
// encoded with the route's schema, every failure an ApiErrorBody with a suggested action.
import {
  NotImplementedError,
  apiError,
  roleOf,
  routes,
  type ActorId,
  type ApiError,
  type ApiErrorBody,
  type ErrorCode,
  type MemberId,
  type RouteName,
  type Routes,
} from '@kitty/shared';
import { LedgerError } from '@kitty/ledger';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiService } from '../ai/types.js';
import { FlowError } from '../flows/errors.js';
import type { MemberAgent } from '../flows/member-agent.js';
import { RelayError } from '../relay/errors.js';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';
import { buildProof } from './proof.js';
import { buildTripView, expenseViewOf, lineViewOf } from './state.js';

export interface RouteDeps {
  /** One agent per actor, from the runtime of A5 (startAgents); missing = not running. */
  agents: ReadonlyMap<ActorId, MemberAgent>;
  /** Each member's own wallet, for the balances of /state (MemberAgent keeps it private). */
  wallets: ReadonlyMap<ActorId, Wallet>;
  /** The on-device AI of the travelers (A4; FakeAi with KITTY_FAKES=1); null if absent. */
  ai: AiService | null;
  fakes: boolean;
  explorerBaseUrl: string;
  now: () => Date;
  /** Proof panel, on-chain rail: is this txid on the explorer? */
  onchainFound?: (txid: string) => Promise<boolean>;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_EVENT: 409,
  TOPUP_REQUIRED: 409,
  INVOICE_EXPIRED: 409,
  INSUFFICIENT_ALLOCATIONS: 409,
  PAYMENT_FAILED: 502,
  NOT_IMPLEMENTED: 501,
  AI_NOT_READY: 503,
  RELAY_UNREACHABLE: 503,
  NODE_UNREACHABLE: 503,
  RECEIVER_UNREACHABLE: 503,
  NO_AVAILABLE_UTXOS: 503,
  INTERNAL: 500,
};
/** Ledger rules (TOTAL_MISMATCH, UNKNOWN_PARTICIPANT, …) are the caller's input: 400. */
const statusOf = (code: ErrorCode) => STATUS[code] ?? 400;

/** A route's own refusal, with the status and action it chooses. */
class RouteError extends Error {
  constructor(
    readonly error: ApiError,
    readonly status: number = statusOf(error.code),
  ) {
    super(error.message);
  }
}
const refuse = (code: ErrorCode, message: string, action?: string) =>
  new RouteError(apiError(code, message, action));

/** Every failure as an ApiError: the code the flows, wallet, relay or ledger chose. */
export function toApiError(err: unknown): { status: number; error: ApiError } {
  if (err instanceof RouteError) return { status: err.status, error: err.error };
  if (err instanceof FlowError || err instanceof WalletError || err instanceof RelayError) {
    return { status: statusOf(err.code), error: err.toApiError() };
  }
  if (err instanceof LedgerError)
    return { status: statusOf(err.code), error: apiError(err.code, err.message) };
  if (err instanceof NotImplementedError) return { status: 501, error: err.error };
  if (err instanceof z.ZodError) {
    return { status: 400, error: apiError('VALIDATION_ERROR', z.prettifyError(err)) };
  }
  return {
    status: 500,
    error: apiError('INTERNAL', err instanceof Error ? err.message : String(err)),
  };
}

type Output<K extends RouteName> = z.output<Routes[K]['response']>;
type Input<K extends RouteName> = {
  params: Routes[K] extends { params: z.ZodType }
    ? z.output<Routes[K]['params']>
    : Record<never, never>;
  body: Routes[K] extends { body: z.ZodType } ? z.output<Routes[K]['body']> : undefined;
};

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  function handle<K extends RouteName>(
    name: K,
    run: (input: Input<K>) => Promise<Output<K>>,
  ): void {
    const def = routes[name];
    app.route({
      method: def.method,
      url: def.path,
      handler: async (req, reply) => {
        try {
          let params: unknown = {};
          if ('params' in def) {
            const p = def.params.safeParse(req.params);
            if (!p.success) {
              const unknownActor = p.error.issues.some((i) => i.path[0] === 'as');
              throw unknownActor
                ? refuse('NOT_FOUND', `unknown member in ${req.url}`)
                : refuse('VALIDATION_ERROR', z.prettifyError(p.error));
            }
            params = p.data;
          }
          const as = (params as { as?: ActorId }).as;
          if (as !== undefined && !(def.roles as readonly string[]).includes(roleOf(as))) {
            throw refuse(
              'NOT_ALLOWED',
              `${as} cannot call ${def.method} ${def.path}`,
              as === 'dave'
                ? 'This is a traveler action. Switch to a traveler window.'
                : 'This is a coordinator action. Switch to dave.',
            );
          }
          let body: unknown = undefined;
          if ('body' in def) {
            const b = def.body.safeParse(req.body);
            if (!b.success) throw refuse('VALIDATION_ERROR', z.prettifyError(b.error));
            body = b.data;
          }
          const out = await run({ params, body } as Input<K>);
          return reply.send(z.encode(def.response as z.ZodType, out as never));
        } catch (err) {
          const { status, error } = toApiError(err);
          // Refusals (4xx, 501, 503) are answers with an action; only a 500 is a bug.
          if (status === 500) app.log.error(err);
          const payload: ApiErrorBody = { error };
          return reply.code(status).send(payload);
        }
      },
    });
  }

  const agentOf = (as: ActorId): MemberAgent => {
    const a = deps.agents.get(as);
    if (a === undefined) {
      throw refuse(
        'NODE_UNREACHABLE',
        `the agent of ${as} is not running`,
        'Start the agents (pnpm dev, or pnpm dev:fakes) and retry.',
      );
    }
    return a;
  };
  const readyAi = (): AiService => {
    if (deps.ai === null || deps.ai.status() !== 'ready') {
      throw refuse('AI_NOT_READY', `on-device AI is ${deps.ai?.status() ?? 'not available'}`);
    }
    return deps.ai;
  };
  /** Travelers who can share an expense: never dave, never excluded (SPEC §11). */
  const activeTravelers = (agent: MemberAgent): MemberId[] =>
    [...(agent.trip()?.members.values() ?? [])]
      .filter((m) => m.channelsReady && !m.excluded)
      .map((m) => m.memberId);

  handle('getState', async ({ params: { as } }) => {
    const agent = deps.agents.get(as) ?? null;
    if (agent !== null) await agent.authorPubkey().catch(() => undefined);
    const wallet = as === 'dave' ? undefined : deps.wallets.get(as);
    const balances = wallet === undefined ? null : await wallet.balances().catch(() => null);
    return buildTripView({
      as,
      agent,
      balances,
      ai: as === 'dave' ? null : (deps.ai?.status() ?? null),
      fakes: deps.fakes,
      explorerBaseUrl: deps.explorerBaseUrl,
      now: deps.now(),
    });
  });

  handle('extractReceipt', async ({ body }) =>
    readyAi().extractReceipt(new Uint8Array(Buffer.from(body.image.dataBase64, 'base64'))),
  );

  handle('proposeSplit', async ({ params: { as }, body }) => {
    const agent = agentOf(as);
    const result = await readyAi().proposeSplit(
      body.receipt,
      activeTravelers(agent),
      body.text,
      body.clarification,
    );
    let preview = null;
    if (
      result.ok &&
      result.data.unassigned.length === 0 &&
      result.data.clarificationNeeded === undefined
    ) {
      // The ledger computes the shares; a proposal it refuses simply has no preview yet.
      try {
        preview = agent.previewSplit(body.receipt, result.data.assignments);
      } catch {
        preview = null;
      }
    }
    return { result, preview };
  });

  handle('submitExpense', async ({ params: { as }, body }) => {
    const agent = agentOf(as);
    const stored = await agent.submitExpense(
      body.receipt,
      body.assignments,
      body.receiptImageSha256,
    );
    const view = expenseViewOf(agent, { eventHash: stored.hash }, deps.now());
    if (view === null) throw refuse('INTERNAL', 'the expense was sent but is not in the log yet');
    return view;
  });

  handle('decideLine', async ({ params: { as, id }, body }) => {
    const agent = agentOf(as);
    return lineViewOf(agent, await agent.decide(id, body.decision, body.reason), deps.now());
  });

  handle('voidExpense', async ({ params: { as, id } }) => {
    const agent = agentOf(as);
    await agent.voidExpense(id);
    const view = expenseViewOf(agent, { expenseId: id }, deps.now());
    if (view === null) throw refuse('NOT_FOUND', `no expense ${id}`);
    return view;
  });

  handle('putPolicy', async ({ params: { as }, body }) => agentOf(as).updatePolicy(body.policy));

  // dave's actions are CoordinatorAgent (A5b), not on main yet.
  const waitingForA5b = async (): Promise<never> => {
    throw refuse('NOT_IMPLEMENTED', "dave's actions arrive with A5b (CoordinatorAgent)");
  };
  handle('resolveDispute', waitingForA5b);
  handle('coverAndExclude', waitingForA5b);
  handle('putRates', waitingForA5b);

  handle('getProof', async ({ params: { paymentHash } }) => {
    // Every agent holds the same verified log; dave's sees every line.
    const agent = deps.agents.get('dave') ?? deps.agents.values().next().value;
    if (agent === undefined) throw refuse('NODE_UNREACHABLE', 'no agent is running');
    const proof = await buildProof(agent, paymentHash, {
      explorerBaseUrl: deps.explorerBaseUrl,
      onchainFound: deps.onchainFound ?? (async () => false),
    });
    if (proof === null)
      throw refuse('NOT_FOUND', `no payment ${paymentHash.slice(0, 8)}… in the log`);
    return proof;
  });
}
