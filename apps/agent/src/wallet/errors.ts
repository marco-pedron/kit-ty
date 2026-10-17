import { ERROR_ACTIONS, type ApiError, type ErrorCode } from '@kitty/shared';

/** Every wallet and rail failure, with a shared code so routes map it to an ApiError. */
export class WalletError extends Error {
  override readonly name = 'WalletError';

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
