import { RlnError } from '@kitty/rln-client';
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

/** The node's APIError names (error.rs at d4762ac) we map; anything else gets a generic code. */
const RLN_CODES: Partial<Record<string, ErrorCode>> = {
  Unreachable: 'NODE_UNREACHABLE',
  LockedNode: 'NODE_UNREACHABLE',
  NotInitialized: 'NODE_UNREACHABLE',
  InsufficientAssets: 'TOPUP_REQUIRED',
  InsufficientCapacity: 'TOPUP_REQUIRED',
  InvalidInvoice: 'VALIDATION_ERROR',
  InvalidAmount: 'VALIDATION_ERROR',
  InvalidAssetID: 'VALIDATION_ERROR',
  IncompleteRGBInfo: 'VALIDATION_ERROR',
  NoAvailableUtxos: 'NO_AVAILABLE_UTXOS',
};

/**
 * Any failure → WalletError. During a payment an unknown failure is PAYMENT_FAILED, elsewhere
 * INTERNAL: never a crash with a raw error, never something a caller could read as success.
 */
export function toWalletError(e: unknown, during: 'pay' | 'other'): WalletError {
  if (e instanceof WalletError) return e;
  const fallback: ErrorCode = during === 'pay' ? 'PAYMENT_FAILED' : 'INTERNAL';
  if (e instanceof RlnError) return new WalletError(RLN_CODES[e.rlnName] ?? fallback, e.message);
  return new WalletError(fallback, e instanceof Error ? e.message : String(e));
}
