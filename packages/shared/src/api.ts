import { z } from 'zod';
import {
  PolicySchema,
  ReceiptResultSchema,
  ReceiptSchema,
  SplitAssignmentSchema,
  SplitResultSchema,
  TranscriptResultSchema,
} from './domain.js';
import {
  ActorIdSchema,
  ExpenseIdSchema,
  Hex32Schema,
  HashHexSchema,
  MemberIdSchema,
  TxidSchema,
} from './ids.js';
import type { Role } from './ids.js';
import { DecimalStringSchema, minorString, positiveMinorString } from './money.js';
import {
  ExpenseViewSchema,
  LineViewSchema,
  ProofRefSchema,
  ProofViewSchema,
  RateViewSchema,
  TripViewSchema,
} from './views.js';

// HTTP contract of the agent (SPEC §14.3). Every schema here is a wire schema: amounts are
// decimal strings of minor units on the wire and bigint in TypeScript, via the money codec.
// Agent: `z.encode(route.response, value)` before sending. Client: `z.decode`.
// Errors: non-2xx with ApiErrorBody `{ error: { code, message, action } }` (errors.ts).
// The role is in the path: a traveler calling a coordinator route gets NOT_ALLOWED, and
// vice versa; `roles` below is what the agent enforces.

// ---------- requests and responses ----------

export const ExtractRequestSchema = z.object({
  image: z.object({
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    dataBase64: z.base64(),
  }),
});

/** WAV, PCM signed 16-bit, mono, 16 kHz, at most 30 s: the agent refuses any other format. */
export const TranscribeRequestSchema = z.object({
  audio: z.object({
    mimeType: z.literal('audio/wav'),
    dataBase64: z.base64(),
  }),
  /** The receipt's item labels, so the model spells them as the split expects. */
  items: z.array(z.string().max(200)).max(100).optional(),
});

export const SplitRequestSchema = z.object({
  receipt: ReceiptSchema,
  text: z.string().min(1),
  /** The answer to a previous clarificationNeeded, passed back to the model once (SPEC §11). */
  clarification: z.object({ question: z.string(), answer: z.string() }).optional(),
});

/** Shares computed by the ledger (never the LLM) with today's rate, before sending. */
export const SplitPreviewSchema = z.object({
  rate: DecimalStringSchema,
  rateAsOf: z.iso.date(),
  totalUsdCents: positiveMinorString,
  shares: z.array(z.object({ member: MemberIdSchema, cents: minorString })),
});
export type SplitPreview = z.output<typeof SplitPreviewSchema>;

export const SplitResponseSchema = z.object({
  result: SplitResultSchema,
  /** null when the proposal is not valid yet (AI failed, unassigned items, no rate). */
  preview: SplitPreviewSchema.nullable(),
});

/** The payer is `:as`. The rate of the day is locked on submit (SPEC §6.3). */
export const SubmitExpenseRequestSchema = z.object({
  receipt: ReceiptSchema,
  assignments: z.array(SplitAssignmentSchema).min(1),
  receiptImageSha256: HashHexSchema,
});

export const DecisionRequestSchema = z
  .object({
    decision: z.enum(['approve', 'contest']),
    reason: z.string().min(1).optional(),
  })
  .refine((r) => r.decision === 'approve' || r.reason !== undefined, {
    message: 'a contest needs a reason',
    path: ['reason'],
  });

export const PutPolicyRequestSchema = z.object({ policy: PolicySchema });

/** KITTY_REGISTRY=v2: what the app shows before and after a block (the exclusion it counts for). */
export const BlockResponseSchema = z.object({ warning: z.string() });

export const ResolveDisputeRequestSchema = z.object({
  outcome: z.enum(['upheld', 'line_voided', 'expense_voided']),
  note: z.string(),
});

export const CoverAndExcludeResponseSchema = z.object({
  /** GUARANTEE_PAID proof; null if the line was beyond the guarantee left (SPEC §6.7). */
  covered: ProofRefSchema.nullable(),
  closingTxids: z.array(TxidSchema),
});

// ---------- routes ----------

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export type RouteDef = {
  method: HttpMethod;
  path: string;
  /** Who may call it; the agent answers NOT_ALLOWED to anyone else. */
  roles: readonly Role[];
  params?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
};

const both = ['traveler', 'coordinator'] as const;
const traveler = ['traveler'] as const;
const coordinator = ['coordinator'] as const;

const As = z.object({ as: ActorIdSchema });
const AsExpense = As.extend({ id: ExpenseIdSchema });
const AsMember = As.extend({ member: MemberIdSchema });
const DaveLine = z.object({ expenseId: ExpenseIdSchema, member: MemberIdSchema });

export const routes = {
  getState: {
    method: 'GET',
    path: '/api/:as/state',
    roles: both,
    params: As,
    response: TripViewSchema,
  },
  extractReceipt: {
    method: 'POST',
    path: '/api/:as/expenses/extract',
    roles: traveler,
    params: As,
    body: ExtractRequestSchema,
    response: ReceiptResultSchema,
  },
  transcribe: {
    method: 'POST',
    path: '/api/:as/expenses/transcribe',
    roles: traveler,
    params: As,
    body: TranscribeRequestSchema,
    response: TranscriptResultSchema,
  },
  proposeSplit: {
    method: 'POST',
    path: '/api/:as/expenses/split',
    roles: traveler,
    params: As,
    body: SplitRequestSchema,
    response: SplitResponseSchema,
  },
  submitExpense: {
    method: 'POST',
    path: '/api/:as/expenses',
    roles: traveler,
    params: As,
    body: SubmitExpenseRequestSchema,
    response: ExpenseViewSchema,
  },
  decideLine: {
    method: 'POST',
    path: '/api/:as/expenses/:id/decision',
    roles: traveler,
    params: AsExpense,
    body: DecisionRequestSchema,
    response: LineViewSchema,
  },
  voidExpense: {
    method: 'POST',
    path: '/api/:as/expenses/:id/void',
    roles: traveler,
    params: AsExpense,
    response: ExpenseViewSchema,
  },
  putPolicy: {
    method: 'PUT',
    path: '/api/:as/policy',
    roles: traveler,
    params: As,
    body: PutPolicyRequestSchema,
    response: PolicySchema,
  },
  /** KITTY_REGISTRY=v2 only (D6): the warning, without blocking. */
  blockWarning: {
    method: 'GET',
    path: '/api/:as/members/:member/block',
    roles: traveler,
    params: AsMember,
    response: BlockResponseSchema,
  },
  blockMember: {
    method: 'POST',
    path: '/api/:as/members/:member/block',
    roles: traveler,
    params: AsMember,
    response: BlockResponseSchema,
  },
  /** C7: removes every block of mine on that member. */
  unblockMember: {
    method: 'POST',
    path: '/api/:as/members/:member/unblock',
    roles: traveler,
    params: AsMember,
    response: z.object({ ok: z.literal(true) }),
  },
  resolveDispute: {
    method: 'POST',
    path: '/api/dave/disputes/:expenseId/:member',
    roles: coordinator,
    params: DaveLine,
    body: ResolveDisputeRequestSchema,
    response: LineViewSchema,
  },
  coverAndExclude: {
    method: 'POST',
    path: '/api/dave/defaults/:expenseId/:member/cover-and-exclude',
    roles: coordinator,
    params: DaveLine,
    response: CoverAndExcludeResponseSchema,
  },
  putRates: {
    method: 'PUT',
    path: '/api/dave/rates',
    roles: coordinator,
    body: RateViewSchema,
    response: RateViewSchema,
  },
  getProof: {
    method: 'GET',
    path: '/api/proof/:paymentHash',
    roles: both,
    // A payment hash, or a txid for the on-chain rail: both are 32 bytes of hex.
    params: z.object({ paymentHash: Hex32Schema }),
    response: ProofViewSchema,
  },
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
