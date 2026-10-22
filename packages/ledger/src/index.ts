// @kitty/ledger: pure money logic and the rules of kit+ty. No I/O.
export {
  ExpenseAllocationSchema,
  ExpenseDraftSchema,
  ExpenseExtrasSchema,
  ExpenseItemSchema,
  ExpenseSchema,
  LockedRateSchema,
  RateTableSchema,
  SettlementSchema,
  ShareSchema,
  type Expense,
  type ExpenseAllocation,
  type ExpenseDraft,
  type ExpenseExtras,
  type ExpenseItem,
  type LockedRate,
  type RateTable,
  type Settlement,
  type Share,
} from '@kitty/shared';
export { allocateByWeight, splitEqually, type Weighted } from './allocate.js';
export { ASSET_PRECISION, assetUnitsToUsdCents, usdCentsToAssetUnits } from './asset.js';
export { computeBalances, type Balances, type NetPosition } from './balances.js';
export { LedgerError, type LedgerErrorCode } from './errors.js';
export { expenseFingerprint, expenseShares, type ShareInput, type ShareResult } from './shares.js';
export { hexToBytes } from './hex.js';
export { allocateExpense, approveExpense, splitOriginal, validateDraft } from './expense.js';
export { convertToUsdCents, lockRate, manualRate, parseRateTable } from './fx.js';
export {
  CURRENCY_EXPONENTS,
  assertCurrency,
  formatMoney,
  isCurrency,
  minorPerMajor,
  type CurrencyCode,
  type Money,
} from './money.js';
export { divRoundHalfUp, parseDecimal, type Rational } from './rational.js';
export {
  autoPaidLast24h,
  decideAutoPay,
  deriveTrip,
  lineKey,
  liquidityPlan,
  upheldDeadlineSeconds,
  validateEvent,
  type ExpenseRecord,
  type LineRecord,
  type LiquidityNeed,
  type MemberState,
  type TripState,
  type ValidationDeps,
  type ValidationResult,
} from './kitty.js';
// Registry v2 (docs/ADR-001-formato-eventi.md): fixed order and conflict rules. deriveTrip
// moves onto them in step 2.
export {
  Causality,
  fixedOrder,
  OrderError,
  stateHash,
  type DagEvent,
  type FixedOrder,
} from './order.js';
export {
  authorHeads,
  duplicateFingerprints,
  effectivePolicy,
  expenseVoided,
  forkedAuthors,
  invoiceToPay,
  lineDecision,
  overpaid,
  paymentMatchesLine,
  settleLine,
} from './conflicts.js';
