// Registry v2 rules (step 2): exported by the ledger index as the `registry` namespace. The
// demo still runs on the legacy log (kitty.ts, validate.ts) until the transport moves (step 4).
export {
  autoPaidLast24h,
  decideRegistryAutoPay,
  invoiceRefusal,
  type RegistryAutoPay,
} from './autopay.js';
export {
  deriveRegistry,
  lineIsOpen,
  type RegistryLine,
  type RegistryLineState,
  type RegistryMember,
  type RegistryTrip,
} from './derive.js';
export {
  blockWarning,
  blockersMajority,
  blockersOf,
  blocks,
  fold,
  groupMajority,
  inTrip,
  isActive,
  isExcluded,
  lineKey,
  pairBlockRefusal,
  voteRefusal,
  voidedByGroup,
  type Fold,
  type VoteOutcome,
} from './fold.js';
export {
  expenseRefusal,
  unixSeconds,
  validateRegistryEvent,
  type RegistryDeps,
} from './validate.js';
