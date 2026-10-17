import { z } from 'zod';
import { CurrencyCodeSchema, DecimalStringSchema } from './money.js';

// In-process schemas of the money ledger copied from the old project (FX, split, balances).
// Every amount is a bigint in minor units of its currency (VND exponent 0, USD/EUR cents).
// Party ids are plain strings: the ledger does not care whether they are member ids or pubkeys.

export const PartyIdSchema = z.string().min(1);
export const MinorAmountSchema = z.bigint().nonnegative();
export const PositiveMinorAmountSchema = z.bigint().positive();

// rates[X] = units of X per 1 USD.
export const RateTableSchema = z.object({
  base: z.literal('USD'),
  asOf: z.iso.date(),
  source: z.string().min(1),
  rates: z.partialRecord(CurrencyCodeSchema, DecimalStringSchema),
});
export type RateTable = z.infer<typeof RateTableSchema>;

// The rate locked when an expense is submitted; stored on the expense, never recomputed.
export const LockedRateSchema = z.object({
  currency: CurrencyCodeSchema,
  value: DecimalStringSchema, // units of `currency` per 1 USD
  asOf: z.iso.date(),
  source: z.enum(['table', 'manual']),
  lockedAt: z.iso.datetime(),
});
export type LockedRate = z.infer<typeof LockedRateSchema>;

// An item with no participants is shared by all participants of the expense.
export const ExpenseItemSchema = z.object({
  label: z.string(),
  amount: MinorAmountSchema,
  participants: z.array(PartyIdSchema),
});
export type ExpenseItem = z.infer<typeof ExpenseItemSchema>;

export const ExpenseExtrasSchema = z.object({
  tax: MinorAmountSchema.optional(),
  service: MinorAmountSchema.optional(),
  tip: MinorAmountSchema.optional(),
});
export type ExpenseExtras = z.infer<typeof ExpenseExtrasSchema>;

// An expense before the rate is locked, in its original currency. total = items + extras.
export const ExpenseDraftSchema = z.object({
  id: z.string().min(1),
  tripId: z.string().min(1),
  description: z.string(),
  currency: CurrencyCodeSchema,
  items: z.array(ExpenseItemSchema),
  extras: ExpenseExtrasSchema,
  total: PositiveMinorAmountSchema,
  payer: PartyIdSchema,
  participants: z.array(PartyIdSchema).min(1),
});
export type ExpenseDraft = z.infer<typeof ExpenseDraftSchema>;

export const ShareSchema = z.object({
  participant: PartyIdSchema,
  amount: MinorAmountSchema,
});
export type Share = z.infer<typeof ShareSchema>;

// Shares in the original currency and in USD cents, computed once with the locked rate.
export const ExpenseAllocationSchema = z.object({
  usdTotalCents: MinorAmountSchema,
  originalShares: z.array(ShareSchema),
  usdShares: z.array(ShareSchema),
});
export type ExpenseAllocation = z.infer<typeof ExpenseAllocationSchema>;

export const ExpenseSchema = ExpenseDraftSchema.extend({
  lockedRate: LockedRateSchema,
  allocation: ExpenseAllocationSchema,
  approvedAt: z.iso.datetime(),
});
export type Expense = z.infer<typeof ExpenseSchema>;

// A debt payment in USD cents. Only `confirmed` settlements change balances.
export const SettlementSchema = z.object({
  id: z.string().min(1),
  tripId: z.string().min(1),
  from: PartyIdSchema,
  to: PartyIdSchema,
  amountCents: PositiveMinorAmountSchema,
  rail: z.enum(['onchain', 'lightning']),
  status: z.enum(['pending', 'confirmed', 'failed']),
  ref: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Settlement = z.infer<typeof SettlementSchema>;
