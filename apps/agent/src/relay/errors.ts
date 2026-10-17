import { ERROR_ACTIONS, type ApiError, type ErrorCode } from '@kitty/shared';

/**
 * Every relay failure, with a shared code so routes map it to an ApiError: RELAY_UNREACHABLE
 * when the relay does not answer, or the relay's own ApiError when it refuses (e.g.
 * INVALID_EVENT with the ledger's reason).
 */
export class RelayError extends Error {
  override readonly name = 'RelayError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly action: string = ERROR_ACTIONS[code],
    /** HTTP status of the relay's answer; null if there was none. */
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, action: this.action };
  }
}
