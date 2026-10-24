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
import { LedgerError, registry } from '@kitty/ledger';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiService } from '../ai/types.js';
import { FlowError } from '../flows/errors.js';
import type { CoordinatorAgent } from '../flows/dave.js';
import type { MemberAgent } from '../flows/member-agent.js';
import type { RegistryAgent } from '../flows/registry-agent.js';
import type { AgentRuntime, RegistryRuntime } from '../flows/runtime.js';
import { RelayError } from '../relay/errors.js';
import { WalletError } from '../wallet/errors.js';
import { buildProof } from './proof.js';
import { buildTripView, expenseViewOf, lineViewOf } from './state.js';
import {
  buildRegistryProof,
  buildRegistryTripView,
  registryExpenseView,
  registryLineView,
} from './state-v2.js';

export interface RouteDeps {
  /**
   * The running agents (startAgents, A5), read at each request: index.ts starts them after
   * the server is built. null = not started yet → 503 with an action.
   */
  runtime: () => AgentRuntime | null;
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
  AGENT_NOT_READY: 503,
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

  const notRunning = (what: string) =>
    refuse(
      'AGENT_NOT_READY',
      `${what} not running yet`,
      'Start the agents (pnpm dev, or pnpm dev:fakes) and retry.',
    );
  const agentOf = (as: ActorId): MemberAgent => {
    const a = deps.runtime()?.agents.get(as);
    if (a === undefined) throw notRunning(`the agent of ${as} is`);
    return a;
  };
  const daveAgent = (): CoordinatorAgent => {
    const d = deps.runtime()?.dave;
    if (d === undefined) throw notRunning("dave's agent is");
    return d;
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

  // KITTY_REGISTRY=v2 (23/10): the travelers' RegistryAgents, the LSP, no coordinator.
  const registryOf = (): RegistryRuntime | null => {
    const rt = deps.runtime();
    return rt?.registry === 'v2' ? (rt.v2 ?? null) : null;
  };
  const travelerV2 = (v2: RegistryRuntime, as: ActorId): RegistryAgent => {
    const a = as === 'dave' ? undefined : v2.travelers.get(as);
    if (a === undefined) throw notRunning(`the agent of ${as} is`);
    return a;
  };
  /** Members of the registry who can share an expense: in the trip, not excluded. */
  const activeV2 = (agent: RegistryAgent): MemberId[] => {
    const trip = agent.view();
    return trip === null
      ? []
      : [...trip.members.values()]
          .filter((m) => registry.isActive(trip.fold, m.pubkey))
          .map((m) => m.displayName as MemberId);
  };
  const noCoordinator = () =>
    refuse(
      'NOT_ALLOWED',
      'With KITTY_REGISTRY=v2 there is no coordinator: dave is only the LSP and routes the payments.',
      'Contests are withdrawn by the debtor or decided by the other members; each member leaves on their own.',
    );
  const v1Only = (what: string) =>
    refuse('NOT_ALLOWED', `${what} needs the registry v2 (KITTY_REGISTRY=v2)`);

  handle('getState', async ({ params: { as } }) => {
    const v2 = registryOf();
    if (v2 !== null) {
      const agent = as === 'dave' ? null : (v2.travelers.get(as) ?? null);
      return buildRegistryTripView({
        as,
        rt: v2,
        balances: agent === null ? null : await agent.balances(),
        ai: as === 'dave' ? null : (deps.ai?.status() ?? null),
        fakes: deps.fakes,
        explorerBaseUrl: deps.explorerBaseUrl,
        now: deps.now(),
      });
    }
    const agent = deps.runtime()?.agents.get(as) ?? null;
    if (agent !== null) await agent.authorPubkey().catch(() => undefined);
    return buildTripView({
      as,
      agent,
      // A traveler's own node only (SPEC §1); null while it does not answer.
      balances: agent === null || as === 'dave' ? null : await agent.balances(),
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
    const v2 = registryOf();
    const agent: MemberAgent | RegistryAgent = v2 === null ? agentOf(as) : travelerV2(v2, as);
    const result = await readyAi().proposeSplit(
      body.receipt,
      'trip' in agent ? activeTravelers(agent) : activeV2(agent),
      body.text,
      body.clarification,
      as === 'dave' ? undefined : as, // traveler-only route: never dave
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
    const v2 = registryOf();
    if (v2 !== null) {
      const agent = travelerV2(v2, as);
      const { expenseId } = await agent.submitExpense(
        body.receipt,
        body.assignments,
        body.receiptImageSha256,
      );
      const view = registryExpenseView(agent, expenseId, deps.now());
      if (view === null)
        throw refuse('INTERNAL', 'the expense was sent but is not in the registry');
      return view;
    }
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
    const v2 = registryOf();
    if (v2 !== null) {
      const agent = travelerV2(v2, as);
      return registryLineView(
        agent,
        await agent.decide(id, body.decision, body.reason),
        deps.now(),
      );
    }
    const agent = agentOf(as);
    return lineViewOf(agent, await agent.decide(id, body.decision, body.reason), deps.now());
  });

  handle('voidExpense', async ({ params: { as, id } }) => {
    const v2 = registryOf();
    if (v2 !== null) {
      const agent = travelerV2(v2, as);
      await agent.voidExpense(id);
      const view = registryExpenseView(agent, id, deps.now());
      if (view === null) throw refuse('NOT_FOUND', `no expense ${id}`);
      return view;
    }
    const agent = agentOf(as);
    await agent.voidExpense(id);
    const view = expenseViewOf(agent, { expenseId: id }, deps.now());
    if (view === null) throw refuse('NOT_FOUND', `no expense ${id}`);
    return view;
  });

  handle('putPolicy', async ({ params: { as }, body }) => {
    const v2 = registryOf();
    return (v2 === null ? agentOf(as) : travelerV2(v2, as)).updatePolicy(body.policy);
  });

  // KITTY_REGISTRY=v2 only: with v1 the agent answers NOT_ALLOWED.
  const blocker = (as: ActorId) => {
    const v2 = registryOf();
    return v2 === null ? agentOf(as) : travelerV2(v2, as);
  };
  handle('blockWarning', async ({ params: { as, member } }) => ({
    warning: await blocker(as).blockWarning(member),
  }));
  handle('blockMember', async ({ params: { as, member } }) => blocker(as).blockMember(member));
  handle('unblockMember', async ({ params: { as, member } }) => {
    await blocker(as).unblockMember(member);
    return { ok: true as const };
  });

  handle('voteLine', async ({ params: { as, id, member }, body }) => {
    const v2 = registryOf();
    if (v2 === null) throw v1Only('Voting on a contested line');
    const agent = travelerV2(v2, as);
    return registryLineView(agent, await agent.vote(id, member, body.outcome), deps.now());
  });

  handle('leaveTrip', async ({ params: { as } }) => {
    const v2 = registryOf();
    if (v2 === null) throw v1Only('Leaving the trip');
    return travelerV2(v2, as).leave();
  });

  handle('restoreFromSeed', async ({ params: { as } }) => {
    const v2 = registryOf();
    if (v2 === null) throw v1Only('Restoring the registry from the seed');
    const agent = travelerV2(v2, as);
    // The trip id is not secret: the new phone knows it from the invite or the operator.
    const tripId = agent.view()?.tripId;
    if (tripId === undefined) throw refuse('NOT_FOUND', `${as} has no trip to restore`);
    return agent.restoreFromSeed(tripId);
  });

  handle('resolveDispute', async ({ params: { expenseId, member }, body }) => {
    if (registryOf() !== null) throw noCoordinator();
    const dave = daveAgent();
    const line = await dave.resolveDispute(expenseId, member, body.outcome, body.note);
    return lineViewOf(dave, line, deps.now());
  });

  handle('coverAndExclude', async ({ params: { expenseId, member } }) => {
    if (registryOf() !== null) throw noCoordinator();
    return daveAgent().coverAndExclude(expenseId, member);
  });

  handle('putRates', async ({ body }) => {
    if (registryOf() !== null) throw noCoordinator();
    await daveAgent().setRate(body);
    return daveAgent().trip()?.rate?.body ?? body;
  });

  handle('getProof', async ({ params: { paymentHash } }) => {
    const v2 = registryOf();
    if (v2 !== null) {
      const proof = buildRegistryProof(v2, paymentHash);
      if (proof === null)
        throw refuse('NOT_FOUND', `no payment ${paymentHash.slice(0, 8)}… in the registry`);
      return proof;
    }
    // Every agent holds the same verified log; dave's sees every line.
    const agent = deps.runtime()?.dave;
    if (agent === undefined) throw notRunning('the agents are');
    const proof = await buildProof(agent, paymentHash, {
      explorerBaseUrl: deps.explorerBaseUrl,
      onchainFound: deps.onchainFound ?? (async () => false),
    });
    if (proof === null)
      throw refuse('NOT_FOUND', `no payment ${paymentHash.slice(0, 8)}… in the log`);
    return proof;
  });
}
