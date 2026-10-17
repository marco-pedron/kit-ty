// openapi.yaml declares no error responses. The body shape { error, code, name } comes from
// upstream rgb-lightning-node src/error.rs (APIErrorResponse) at the pinned commit d4762ac.
// Callers branch only on `name`; a body of any other shape becomes name 'Unknown'.

export interface RlnErrorBody {
  error: string;
  code: number;
  name: string;
}

export function isRlnErrorBody(body: unknown): body is RlnErrorBody {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b.error === 'string' && typeof b.code === 'number' && typeof b.name === 'string';
}

export class RlnError extends Error {
  override readonly name = 'RlnError';

  constructor(
    readonly endpoint: string,
    /** HTTP status; 0 when the node could not be reached at all. */
    readonly status: number,
    /** APIError name from error.rs (e.g. 'LockedNode'), or 'Unknown'. */
    readonly rlnName: string,
    readonly detail: string,
  ) {
    super(`${endpoint}: HTTP ${status} ${rlnName}: ${detail}`);
  }
}

/** Builds an RlnError from whatever the node returned (JSON body, text, or nothing). */
export function toRlnError(endpoint: string, status: number, body: unknown): RlnError {
  if (isRlnErrorBody(body)) return new RlnError(endpoint, status, body.name, body.error);
  let detail: string;
  try {
    detail = typeof body === 'string' ? body : (JSON.stringify(body ?? null) ?? '');
  } catch {
    detail = String(body);
  }
  return new RlnError(endpoint, status, 'Unknown', detail.slice(0, 500));
}
