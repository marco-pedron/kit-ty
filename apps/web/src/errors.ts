import type { ApiClientError, ErrorCode } from '@kitty/shared';

// Every error the UI can show, in one place (task C7): a human sentence and one next step, never
// a raw code. The agent's own message is technical (it names states and fields); it stays as an
// optional detail under the sentence.

export interface HumanError {
  title: string;
  action: string;
  /** "Try again" makes sense: the same request can succeed later. */
  retry: boolean;
}

const H = (title: string, action: string, retry = false): HumanError => ({ title, action, retry });

export const HUMAN_ERRORS: Record<ErrorCode, HumanError> = {
  UNKNOWN_CURRENCY: H(
    "This receipt's currency is not one the trip knows.",
    'Pick the currency from the list.',
  ),
  MISSING_RATE: H(
    'There is no rate of the day for this currency yet.',
    'Ask Dave to set it, then send again.',
  ),
  INVALID_RATE: H("Today's rate is not valid.", 'Ask Dave to set the rate of the day again.'),
  INVALID_RATE_TABLE: H(
    'One of the rates is not a positive number.',
    'Fix the rate and set it again.',
  ),
  TOTAL_MISMATCH: H(
    "The rows don't add up to the total.",
    'Fix a row or the total, then try again.',
  ),
  UNKNOWN_PARTICIPANT: H(
    'Someone in the split is not in this trip.',
    'Split only between active travelers.',
  ),
  DUPLICATE_PARTICIPANT: H(
    'The same person is in the split twice.',
    'Remove the duplicate and try again.',
  ),
  INVALID_ASSIGNMENT: H(
    'Some rows are not assigned to anyone.',
    'Say who had every row, then split again.',
  ),
  NEGATIVE_AMOUNT: H('An amount is negative.', 'Fix the row and try again.'),
  EMPTY_ALLOCATION: H(
    'Nobody else shares this expense.',
    'Add at least one other traveler to the split.',
  ),
  INVALID_EVENT: H(
    'This entry did not pass the checks of the log.',
    'Ask the sender to send it again.',
  ),
  NOT_IMPLEMENTED: H('This is not available yet.', 'It comes in a later version.'),
  TOPUP_REQUIRED: H(
    'Your trip channel is too low for this payment.',
    'Top up your channel, then try again.',
  ),
  AI_NOT_READY: H(
    'The AI on your phone is still waking up.',
    'Wait a few seconds and try again.',
    true,
  ),
  AGENT_NOT_READY: H('Your agent is still starting.', 'Wait a few seconds and try again.', true),
  NOT_ALLOWED: H('Only someone else can do this.', 'Switch to the right person.'),
  NOT_FOUND: H('This is not there any more.', 'Go back and refresh.'),
  VALIDATION_ERROR: H(
    'Something in the form is missing or not valid.',
    'Check the fields and try again.',
  ),
  RELAY_UNREACHABLE: H(
    'The trip relay is not answering.',
    'Your agent keeps a copy and retries. Check your connection.',
    true,
  ),
  INTERNAL: H(
    'Something went wrong on your phone.',
    'Try again; if it keeps happening, reload the app.',
    true,
  ),
  NODE_UNREACHABLE: H('Your Lightning node is not answering.', 'Try again in a few seconds.', true),
  INVOICE_EXPIRED: H(
    'The payment request expired.',
    'The payer is issuing a new one: try again in a moment.',
    true,
  ),
  PAYMENT_FAILED: H(
    "The payment didn't go through. Nothing was sent.",
    'Try again; if it fails again, ask Dave.',
    true,
  ),
  RECEIVER_UNREACHABLE: H(
    "The person you're paying is offline.",
    'Try again in a few seconds.',
    true,
  ),
  INSUFFICIENT_ALLOCATIONS: H(
    'There are not enough digital dollars available.',
    'Top up, then try again.',
  ),
  NO_AVAILABLE_UTXOS: H('Your wallet needs a moment to get ready.', 'Try again in a minute.', true),
};

/** HTTP 0: the request never reached the agent (network, agent down, proxy). */
const OFFLINE = H("Can't reach your agent.", 'Check your connection. It retries by itself.', true);

/** The sentence, action and retry for any client error; with `who`, names the node in question. */
export function humanError(
  e: Pick<ApiClientError, 'code' | 'httpStatus'>,
  who?: string,
): HumanError {
  if (e.httpStatus === 0 && e.code === 'INTERNAL') return OFFLINE;
  const h = HUMAN_ERRORS[e.code];
  if (who !== undefined && (e.code === 'NODE_UNREACHABLE' || e.code === 'RECEIVER_UNREACHABLE'))
    return { ...h, title: `${who}'s node is not answering.` };
  return h;
}
