import { z } from 'zod';
import { routes, type RouteDef, type RouteName, type Routes } from './api.js';
import { ApiErrorBodySchema, ERROR_ACTIONS, type ErrorCode } from './errors.js';
import { roleOf, type ActorId } from './ids.js';

// Typed client of the agent API, built from `routes`: bigint in TypeScript, decimal strings
// on the wire. Bound to one actor: `:as` is filled in, so each method takes one object that
// merges the other path params and the body (e.g. { id, decision, reason }).

type Empty = Record<never, never>;
type Part<R, K extends string> = R extends { [P in K]: infer S extends z.ZodType }
  ? z.output<S>
  : Empty;
type Flatten<T> = { [K in keyof T]: T[K] };

export type RouteInput<R extends RouteDef> = Flatten<
  Omit<Part<R, 'params'>, 'as'> & Part<R, 'body'>
>;
export type RouteOutput<R extends RouteDef> = z.output<R['response']>;

export type AgentClient = {
  [K in RouteName]: Empty extends RouteInput<Routes[K]>
    ? (input?: RouteInput<Routes[K]>) => Promise<RouteOutput<Routes[K]>>
    : (input: RouteInput<Routes[K]>) => Promise<RouteOutput<Routes[K]>>;
};

/**
 * Every failure the UI sees: an ApiError from the agent, or a transport or contract failure
 * mapped to INTERNAL. `action` is always one human next step.
 */
export class ApiClientError extends Error {
  override readonly name = 'ApiClientError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly action: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `baseUrl` '' = same origin (the Vite dev server proxies /api to the agent). */
export function createAgentClient(
  baseUrl: string,
  as: ActorId,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): AgentClient {
  const call = async (name: RouteName, input: Record<string, unknown> = {}) => {
    const route: RouteDef = routes[name];
    if (!route.roles.includes(roleOf(as))) {
      throw new ApiClientError(
        'NOT_ALLOWED',
        `${name} is not available to ${as}`,
        ERROR_ACTIONS.NOT_ALLOWED,
        0,
      );
    }
    const merged = { ...input, as };
    // Object schemas strip unknown keys, so each part is encoded from the merged input.
    let path = route.path;
    if (route.params) {
      const params = z.encode(route.params, merged as never) as Record<string, unknown>;
      for (const [k, v] of Object.entries(params))
        path = path.replace(`:${k}`, encodeURIComponent(String(v)));
    }
    const init: RequestInit = { method: route.method };
    if (route.body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(z.encode(route.body, merged as never));
    }

    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, init);
    } catch (e) {
      throw new ApiClientError(
        'INTERNAL',
        `cannot reach the agent: ${e instanceof Error ? e.message : String(e)}`,
        'Check that the agent is running (pnpm dev) and retry.',
        0,
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const err = ApiErrorBodySchema.safeParse(json);
      if (err.success) {
        const { code, message, action } = err.data.error;
        throw new ApiClientError(code, message, action, res.status);
      }
      throw new ApiClientError(
        'INTERNAL',
        `${route.method} ${route.path}: HTTP ${res.status}`,
        ERROR_ACTIONS.INTERNAL,
        res.status,
      );
    }

    const out = route.response.safeDecode(json);
    if (!out.success) {
      throw new ApiClientError(
        'INTERNAL',
        `${route.method} ${route.path}: response does not match the contract: ${out.error.message}`,
        ERROR_ACTIONS.INTERNAL,
        res.status,
      );
    }
    return out.data;
  };

  return Object.fromEntries(
    (Object.keys(routes) as RouteName[]).map((name) => [
      name,
      (input?: Record<string, unknown>) => call(name, input),
    ]),
  ) as unknown as AgentClient;
}
