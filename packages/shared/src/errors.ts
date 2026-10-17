import { z } from 'zod';

// Every error code the agent API can return. The ledger's LedgerErrorCode must stay a
// subset (checked by a type test in packages/ledger).
export const ErrorCodeSchema = z.enum([
  // ledger rules
  'UNKNOWN_CURRENCY',
  'MISSING_RATE',
  'INVALID_RATE',
  'INVALID_RATE_TABLE',
  'TOTAL_MISMATCH',
  'UNKNOWN_PARTICIPANT',
  'DUPLICATE_PARTICIPANT',
  'INVALID_ASSIGNMENT',
  'NEGATIVE_AMOUNT',
  'EMPTY_ALLOCATION',
  'INVALID_EVENT',
  'NOT_IMPLEMENTED',
  // agent and API
  'TOPUP_REQUIRED',
  'AI_NOT_READY',
  'AGENT_NOT_READY',
  'NOT_ALLOWED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'RELAY_UNREACHABLE',
  'INTERNAL',
  // Lightning and RGB nodes
  'NODE_UNREACHABLE',
  'INVOICE_EXPIRED',
  'PAYMENT_FAILED',
  'RECEIVER_UNREACHABLE',
  'INSUFFICIENT_ALLOCATIONS',
  'NO_AVAILABLE_UTXOS',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** `action` is always one next step a user can take (SPEC §2, UX; task C7). */
export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  action: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The wire body of every non-2xx response. */
export const ApiErrorBodySchema = z.object({ error: ApiErrorSchema });
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

// The default suggested action per code; the agent may send a more specific one.
export const ERROR_ACTIONS: Record<ErrorCode, string> = {
  UNKNOWN_CURRENCY: 'Pick the receipt currency from the list.',
  MISSING_RATE: 'Ask the coordinator to set the rate of the day for this currency.',
  INVALID_RATE: 'Ask the coordinator to fix the rate of the day.',
  INVALID_RATE_TABLE: 'Check the rates: each one must be a positive number.',
  TOTAL_MISMATCH: 'The items do not add up to the total. Fix an item or the total, then retry.',
  UNKNOWN_PARTICIPANT: 'Assign the items only to travelers on this trip.',
  DUPLICATE_PARTICIPANT: 'Remove the duplicate name and retry.',
  INVALID_ASSIGNMENT: 'Assign every item to at least one traveler.',
  NEGATIVE_AMOUNT: 'Amounts cannot be negative. Fix the item and retry.',
  EMPTY_ALLOCATION: 'Assign at least one item before sending.',
  INVALID_EVENT: 'This entry failed verification and was ignored. Ask the sender to send it again.',
  NOT_IMPLEMENTED: 'This feature is not ready yet.',
  TOPUP_REQUIRED: 'Your trip channel is too low to pay this. Top up your channel, then retry.',
  AI_NOT_READY:
    'The on-device AI is still loading. Wait a few seconds, or fill in the form by hand.',
  AGENT_NOT_READY: 'The agents are still starting. Wait a few seconds and retry.',
  NOT_ALLOWED: 'Only the right person can do this. Switch to the right account.',
  NOT_FOUND: 'This item no longer exists. Refresh the page.',
  VALIDATION_ERROR: 'Some fields are missing or invalid. Check the form and retry.',
  RELAY_UNREACHABLE:
    'Cannot reach the trip relay. Your agent keeps a copy and retries; check the connection.',
  INTERNAL: 'Something went wrong on your device. Retry; if it persists, restart the app.',
  NODE_UNREACHABLE: 'Your Lightning node is not responding. Wait a moment and retry.',
  INVOICE_EXPIRED:
    'The payment request expired. The payer will issue a new one; retry in a moment.',
  PAYMENT_FAILED:
    'The payment did not go through and nothing was sent. Retry; if it fails again, ask the coordinator.',
  RECEIVER_UNREACHABLE: 'The person you are paying is offline. Retry later.',
  INSUFFICIENT_ALLOCATIONS: 'Not enough digital dollars available. Top up, then retry.',
  NO_AVAILABLE_UTXOS: 'Your wallet needs a moment to prepare. Retry in a minute.',
};

export function apiError(code: ErrorCode, message: string, action = ERROR_ACTIONS[code]): ApiError {
  return { code, message, action };
}
