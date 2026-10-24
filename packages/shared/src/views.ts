import { z } from 'zod';
import {
  AiStatusSchema,
  AutoPayDecisionSchema,
  LineStateSchema,
  PolicySchema,
  TripParamsSchema,
} from './domain.js';
import { ApiErrorSchema } from './errors.js';
import { EventTypeSchema as RegistryEventTypeSchema } from './events.js';
import { EventTypeSchema } from './legacy-events.js';
import {
  ActorIdSchema,
  ExpenseIdSchema,
  HashHexSchema,
  MemberIdSchema,
  NodePubkeySchema,
  PreimageHexSchema,
  PubkeySchema,
  RoleSchema,
  TripIdSchema,
  TxidSchema,
} from './ids.js';
import {
  CurrencyCodeSchema,
  DecimalStringSchema,
  minorString,
  moneyString,
  positiveMinorString,
} from './money.js';

// What GET /api/:as/state returns (SPEC §14.3). The UI polls it every second and renders
// only from it. Privacy (SPEC §1): a traveler sees only their own balances; the group sees
// what is in the signed log (expenses, lines, payments), never anyone else's channel.

/** One explicit check, shown as "✓ label" or "✗ label: detail". */
export const CheckSchema = z.object({
  ok: z.boolean(),
  label: z.string(),
  detail: z.string(),
});
export type Check = z.infer<typeof CheckSchema>;

export const ProofRefSchema = z.discriminatedUnion('rail', [
  z.object({ rail: z.literal('ln'), paymentHash: HashHexSchema }),
  z.object({ rail: z.literal('onchain'), txid: TxidSchema }),
]);
export type ProofRef = z.output<typeof ProofRefSchema>;

// ---------- lines and expenses ----------

/** One line = (expense, debtor), SPEC §7. */
export const LineViewSchema = z.object({
  expenseId: ExpenseIdSchema,
  expenseEventHash: HashHexSchema,
  /** The creditor. */
  payer: MemberIdSchema,
  debtor: MemberIdSchema,
  cents: positiveMinorString,
  itemIndexes: z.array(z.number().int().nonnegative()),
  state: LineStateSchema,
  seenAt: z.iso.datetime().nullable(),
  /**
   * The next deadline for the current state, for the countdown: end of silent assent in
   * awaiting_decision, payment deadline in awaiting_explicit/due. null in the other states.
   */
  deadlineAt: z.iso.datetime().nullable(),
  /** The debtor's reason when contested. */
  contestReason: z.string().nullable(),
  resolution: z
    .object({ outcome: z.enum(['upheld', 'line_voided', 'expense_voided']), note: z.string() })
    .nullable(),
  /**
   * What the debtor's agent decided and why ("Paid 3.09 to alice automatically: …").
   * Only on the debtor's own lines; null elsewhere.
   */
  agent: AutoPayDecisionSchema.nullable(),
  paidBy: z.enum(['debtor', 'guarantee']).nullable(),
  proof: ProofRefSchema.nullable(),
  invoiceExpiresAt: z.iso.datetime(),
  /**
   * KITTY_REGISTRY=v2 only (23/10, provisional): the vote of the other members on a contested
   * line. `voters` exclude creditor and debtor; `outcome` is definitive once reached. `canVote`:
   * the viewer may vote now. Absent with v1; null on a line never contested.
   */
  group: z
    .object({
      voters: z.array(MemberIdSchema),
      due: z.array(MemberIdSchema),
      voided: z.array(MemberIdSchema),
      outcome: z.enum(['due', 'voided']).nullable(),
      canVote: z.boolean(),
    })
    .nullable()
    .optional(),
  /** KITTY_REGISTRY=v2 only: why a due line is payable by hand only (blocks, exclusions). */
  manualOnly: z.enum(['blocked', 'creditor_excluded', 'debtor_excluded']).nullable().optional(),
});
export type LineView = z.output<typeof LineViewSchema>;

export const ExpenseItemViewSchema = z.object({
  index: z.number().int().nonnegative(),
  label: z.string(),
  quantity: z.number().int().positive(),
  /** Minor units of the receipt currency. */
  total: minorString,
  members: z.array(MemberIdSchema),
});
export type ExpenseItemView = z.output<typeof ExpenseItemViewSchema>;

export const ExpenseViewSchema = z.object({
  expenseId: ExpenseIdSchema,
  eventHash: HashHexSchema,
  payer: MemberIdSchema,
  submittedAt: z.iso.datetime(),
  merchant: z.string(),
  date: z.iso.date(),
  currency: CurrencyCodeSchema,
  /** Minor units of the receipt currency (VND has none). */
  receiptTotal: positiveMinorString,
  /** Units of the receipt currency per 1 USD, locked at submission. */
  rate: DecimalStringSchema,
  totalUsdCents: positiveMinorString,
  payerCents: minorString,
  items: z.array(ExpenseItemViewSchema),
  lines: z.array(LineViewSchema),
  status: z.enum(['open', 'settled', 'voided']),
  receiptImageSha256: HashHexSchema,
  warnings: z.array(z.string()),
});
export type ExpenseView = z.output<typeof ExpenseViewSchema>;

// ---------- members ----------

/** v1: joined → admitted → active → excluded. v2 also `left` (MEMBER_LEFT, channels closed). */
export const MemberStatusSchema = z.enum(['joined', 'admitted', 'active', 'excluded', 'left']);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/** Public facts about a member, from the log. No balances. */
export const MemberViewSchema = z.object({
  memberId: MemberIdSchema,
  displayName: z.string(),
  pubkey: PubkeySchema,
  nodePubkey: NodePubkeySchema,
  /** joined → admitted by dave → active (CHANNELS_READY) → excluded. */
  status: MemberStatusSchema,
  /** Channel closing txids when excluded, for the explorer link. */
  closingTxids: z.array(TxidSchema),
  /**
   * KITTY_REGISTRY=v2: this member as the viewer's registry v2 sees it (null before the viewer
   * is in it). Absent with v1.
   */
  registry: z.object({ blockedByMe: z.boolean(), excluded: z.boolean() }).nullable().optional(),
});
export type MemberView = z.output<typeof MemberViewSchema>;

/** The traveler's own channels, from their own node only. */
export const BalanceViewSchema = z.object({
  /** What I can spend in my trip channel: "only you can spend it". */
  tripOutboundCents: minorString,
  /** What I can receive now (dave's side of my channels, SPEC §10.5). */
  inboundCents: minorString,
  onchainCents: minorString,
  /** D, for "x of 50.00". */
  tripChannelCents: minorString,
  /** Below topupWarnPercent of D (SPEC §6.9). */
  topupWarning: z.boolean(),
});
export type BalanceView = z.output<typeof BalanceViewSchema>;

export const MeViewSchema = z.object({
  memberId: MemberIdSchema,
  policy: PolicySchema,
  /** null while my node is unreachable (the UI shows the NODE_UNREACHABLE action). */
  balance: BalanceViewSchema.nullable(),
  /** Σ of my open lines as debtor (not paid, guaranteed or voided). */
  oweCents: minorString,
  /** Σ of open lines owed to me. */
  owedToMeCents: minorString,
  /** Paid automatically in the last 24 h, against policy.dailyCapCents. */
  autoPaidTodayCents: minorString,
  /** Lines where I am the debtor (Da approvare), every state, newest first. */
  debts: z.array(LineViewSchema),
  /**
   * Lines another member owes me, symmetric to `debts`, every state (due, paid, guaranteed,
   * overdue, voided…), newest first. `debtor` says who owes it; `paidBy` and `proof` say how it
   * was settled, e.g. "Reimbursed 6.59: 3.09 from bob, 3.50 guaranteed by the operator".
   */
  credits: z.array(LineViewSchema),
  /**
   * KITTY_REGISTRY=v2: shown before leaving: the credits still open, from whom and how much,
   * collected outside the app once the channels are closed. Null when nothing is owed to me.
   */
  leaveWarning: z.string().nullable().optional(),
});
export type MeView = z.output<typeof MeViewSchema>;

// ---------- coordinator ----------

export const DisputeViewSchema = z.object({
  expenseId: ExpenseIdSchema,
  expenseEventHash: HashHexSchema,
  payer: MemberIdSchema,
  debtor: MemberIdSchema,
  cents: positiveMinorString,
  reason: z.string(),
  contestedAt: z.iso.datetime(),
  merchant: z.string(),
  currency: CurrencyCodeSchema,
  /** The items the AI extracted and assigned to this debtor. */
  items: z.array(ExpenseItemViewSchema),
  /** dave asks the payer to show the photo with this hash (SPEC §6.6). */
  receiptImageSha256: HashHexSchema,
});
export type DisputeView = z.output<typeof DisputeViewSchema>;

export const DefaultViewSchema = z.object({
  expenseId: ExpenseIdSchema,
  expenseEventHash: HashHexSchema,
  /** The creditor dave pays with the guarantee. */
  payer: MemberIdSchema,
  debtor: MemberIdSchema,
  cents: positiveMinorString,
  overdueSince: z.iso.datetime(),
  debtorExcluded: z.boolean(),
  /** G minus what was already covered for this debtor. */
  guaranteeLeftCents: minorString,
  /** cents ≤ guaranteeLeftCents: the same invoice is paid in full or not at all. */
  coverable: z.boolean(),
});
export type DefaultView = z.output<typeof DefaultViewSchema>;

export const OperatorMemberViewSchema = z.object({
  memberId: MemberIdSchema,
  guaranteeUsedCents: minorString,
  guaranteeLeftCents: minorString,
  /** What the operator recovers off-platform from this member. */
  operatorCreditCents: minorString,
  /** margin(m) of liquidityPlan (SPEC §10.5); null when unknown. */
  liquidityMarginCents: moneyString.nullable(),
});
export type OperatorMemberView = z.output<typeof OperatorMemberViewSchema>;

export const CoordinatorViewSchema = z.object({
  members: z.array(OperatorMemberViewSchema),
  disputes: z.array(DisputeViewSchema),
  defaults: z.array(DefaultViewSchema),
});
export type CoordinatorView = z.output<typeof CoordinatorViewSchema>;

// ---------- log, activity, waits ----------

/** "Registro verificato" (SPEC §9.5). */
export const LedgerHealthSchema = z.object({
  events: z.number().int().nonnegative(),
  validSignatures: z.number().int().nonnegative(),
  chainValid: z.boolean(),
  headSeq: z.number().int().nonnegative(),
  headHash: HashHexSchema.nullable(),
  /** "same on N/N phones" (P1); null until checkpoints are compared. */
  checkpoints: z
    .object({ matching: z.number().int().nonnegative(), compared: z.number().int().positive() })
    .nullable(),
});
export type LedgerHealth = z.infer<typeof LedgerHealthSchema>;

/** One row of Attività: an event of the log, or a decision of my agent. */
export const ActivityItemSchema = z.object({
  at: z.iso.datetime(),
  kind: z.union([EventTypeSchema, RegistryEventTypeSchema, z.literal('AGENT')]),
  /** Human sentence, e.g. "Your agent paid 3.09 to alice: no objection in 20 s, under 20.00". */
  text: z.string(),
  expenseId: ExpenseIdSchema.nullable(),
  proof: ProofRefSchema.nullable(),
});
export type ActivityItem = z.output<typeof ActivityItemSchema>;

/** A long step in progress or just finished, so every wait says what is happening (C7). */
export const OperationViewSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'extracting_receipt',
    'proposing_split',
    'submitting_expense',
    'paying',
    'covering',
    'closing_channels',
    'opening_liquidity',
    'backing_up',
  ]),
  status: z.enum(['running', 'done', 'failed']),
  /** e.g. "Routing through the operator's node…". */
  text: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  error: ApiErrorSchema.nullable(),
});
export type OperationView = z.infer<typeof OperationViewSchema>;

// ---------- the whole state ----------

export const TripInfoSchema = z.object({
  tripId: TripIdSchema,
  name: z.string(),
  assetId: z.string(),
  status: z.enum(['open', 'closed']),
  params: TripParamsSchema,
});
export type TripInfo = z.output<typeof TripInfoSchema>;

export const RateViewSchema = z.object({
  asOf: z.iso.date(),
  source: z.string(),
  rates: z.partialRecord(CurrencyCodeSchema, DecimalStringSchema),
});
export type RateView = z.output<typeof RateViewSchema>;

export const TripViewSchema = z
  .object({
    as: ActorIdSchema,
    role: RoleSchema,
    /** KITTY_FAKES=1: the UI shows a banner on every screen. */
    fakes: z.boolean(),
    /**
     * KITTY_REGISTRY: v2 has no coordinator (dave is only the LSP), votes on contested lines
     * and leaving. Absent = v1.
     */
    registry: z.enum(['v1', 'v2']).optional(),
    /** Server clock, so countdowns do not depend on the browser clock. */
    serverNow: z.iso.datetime(),
    /** null before TRIP_CREATED. */
    trip: TripInfoSchema.nullable(),
    rate: RateViewSchema.nullable(),
    members: z.array(MemberViewSchema),
    /** The traveler's own view; null for dave. */
    me: MeViewSchema.nullable(),
    /** dave's screens; null for travelers. */
    coordinator: CoordinatorViewSchema.nullable(),
    expenses: z.array(ExpenseViewSchema),
    activity: z.array(ActivityItemSchema),
    operations: z.array(OperationViewSchema),
    ai: AiStatusSchema,
    ledger: LedgerHealthSchema,
    /** Esplora REST base, for `/tx/<txid>` links. */
    explorerBaseUrl: z.string(),
  })
  // Privacy (SPEC §1): operator data (liquidity margins, guarantee, credits) is dave's only,
  // and a traveler's own balances never reach dave's screens.
  .superRefine((v, ctx) => {
    const traveler = v.as !== 'dave';
    if (v.role !== (traveler ? 'traveler' : 'coordinator'))
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'role does not match as' });
    if (traveler && v.coordinator !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['coordinator'],
        message: 'travelers never get the coordinator view',
      });
    if (traveler && v.me?.memberId !== v.as)
      ctx.addIssue({
        code: 'custom',
        path: ['me'],
        message: 'a traveler gets only their own view',
      });
    if (!traveler && v.me !== null)
      ctx.addIssue({ code: 'custom', path: ['me'], message: 'dave has no traveler view' });
  });
export type TripView = z.output<typeof TripViewSchema>;

// ---------- proof panel (SPEC §10.2) ----------

export const ProofViewSchema = z.discriminatedUnion('rail', [
  z.object({
    rail: z.literal('ln'),
    paymentHash: HashHexSchema,
    preimage: PreimageHexSchema,
    cents: positiveMinorString,
    payeePubkey: NodePubkeySchema,
    expenseId: ExpenseIdSchema,
    creditor: MemberIdSchema,
    debtor: MemberIdSchema,
    paidBy: z.enum(['debtor', 'guarantee']),
    checks: z.object({
      /** sha256(preimage) == paymentHash */
      preimageMatchesHash: CheckSchema,
      /** invoice payee_pubkey == creditor's registered node */
      invoiceSignedByCreditor: CheckSchema,
      /** invoice amount and asset == line amount */
      amountMatches: CheckSchema,
    }),
    verified: z.boolean(),
  }),
  z.object({
    rail: z.literal('onchain'),
    txid: TxidSchema,
    explorerUrl: z.string(),
    cents: positiveMinorString,
    expenseId: ExpenseIdSchema,
    creditor: MemberIdSchema,
    debtor: MemberIdSchema,
    checks: z.object({ txFound: CheckSchema, amountMatches: CheckSchema }),
    verified: z.boolean(),
  }),
]);
export type ProofView = z.output<typeof ProofViewSchema>;
