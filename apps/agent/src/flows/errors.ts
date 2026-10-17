import { ERROR_ACTIONS, type ApiError, type ErrorCode } from '@kitty/shared';
import { WalletError } from '../wallet/errors.js';

/** A flow that cannot proceed, with a shared code so routes map it to an ApiError. */
export class FlowError extends Error {
  override readonly name = 'FlowError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly action: string = ERROR_ACTIONS[code],
  ) {
    super(message);
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, action: this.action };
  }
}

/** Any failure of a flow as the ApiError shown in the UI, with its suggested action. */
export function apiErrorOf(err: unknown): ApiError {
  return err instanceof WalletError || err instanceof FlowError
    ? err.toApiError()
    : { code: 'INTERNAL', message: String(err), action: ERROR_ACTIONS.INTERNAL };
}
