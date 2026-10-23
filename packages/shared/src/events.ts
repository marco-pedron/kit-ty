import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';
import { nip44Decrypt, nip44Encrypt, Nip44Error } from './content.js';
import { ReceiptSchema } from './domain.js';
import {
  Bolt11Schema,
  ExpenseIdSchema,
  HashHexSchema,
  PreimageHexSchema,
  TripIdSchema,
  TxidSchema,
} from './ids.js';
import { minorString, positiveMinorString } from './money.js';
import {
  KIND_REGISTRY,
  NostrFormatError,
  NostrIdSchema,
  parseRegistryTags,
  registryTags,
  XOnlyPubkeySchema,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr.js';

// The trip registry on Nostr, format v2 (docs/ADR-001-formato-eventi.md). Exported by
// index.ts as the `registry` namespace; the format the demo runs on is in legacy-events.ts
// until step 2 switches the ledger over.
//
// No member has special powers: no coordinator, no Dave-only types. Every member identity is
// its per-trip registry key (x-only, NIP-06 in step 3). Amounts are base units of the trip
// asset as decimal strings ("309" with assetDecimals 2); the precision is a trip parameter.
// Every reference to another event is its Nostr id.

/** A member: the x-only registry key of the trip. */
export const MemberKeySchema = XOnlyPubkeySchema;
/** Nostr id of an event of the same trip. */
export const EventRefSchema = NostrIdSchema;

/** Base units of the trip asset, ≥ 0 / > 0. bigint in TypeScript, decimal string on the wire. */
export const AmountSchema = minorString;
export const PositiveAmountSchema = positiveMinorString;

const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// ---------- trip and members ----------

/** Fixed when the trip is created; never updated (no event can change them). */
export const TripParamsSchema = z
  .object({
    /** The only identifier of the asset: tickers and names are display only. */
    assetId: z.string().min(1),
    assetDecimals: z.number().int().min(0).max(18),
    /** Shares are rounded to 10^(assetDecimals - displayDecimals) base units. */
    displayDecimals: z.number().int().min(0).max(18),
    silentAssentSeconds: z.number().int().positive(),
    /** At least 24 h, default 48 h (§0bis.3 of the plan). */
    invoiceExpirySeconds: z.number().int().min(86_400).default(172_800),
    /** Older rates warn the payer (step 5). */
    rateMaxAgeSeconds: z.number().int().positive(),
    /** Accepted rate sources (step 5); empty = unsigned rates only. */
    oracles: z.array(z.string().min(1)),
  })
  .refine((p) => p.displayDecimals <= p.assetDecimals, {
    message: 'displayDecimals must not exceed assetDecimals',
    path: ['displayDecimals'],
  });
export type TripParams = z.output<typeof TripParamsSchema>;

/** The default of TripParams.invoiceExpirySeconds: 48 h. */
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 172_800;

export const PolicySchema = z.object({
  /** Above this per line, no silent assent. */
  autoPayLimit: AmountSchema,
  /** Max paid automatically in 24 hours, measured on the payer's own clock. */
  dailyCap: AmountSchema,
});
export type Policy = z.output<typeof PolicySchema>;

const RelayUrlSchema = z.string().regex(/^wss?:\/\/\S+$/, 'expected a ws:// or wss:// URL');

export const TripCreatedBodySchema = z.object({
  name: z.string().min(1),
  params: TripParamsSchema,
  relays: z.array(RelayUrlSchema).min(1),
});

export const MemberInvitedBodySchema = z.object({
  inviteId: z.string().regex(/^[0-9a-f]{32}$/, 'expected 16 bytes of lowercase hex'),
  /** When the inviter already knows the invitee's registry key. */
  inviteePubkey: MemberKeySchema.optional(),
  expiresAt: unixSeconds,
});

export const MemberJoinedBodySchema = z.object({
  /** The MEMBER_INVITED used; null only for whoever wrote TRIP_CREATED (step 2 checks it). */
  inviteRef: EventRefSchema.nullable(),
  displayName: z.string().min(1).max(64),
  /** secp256k1 compressed key of the member's Lightning node (payee of its invoices). */
  nodePubkey: z.string().regex(/^0[23][0-9a-f]{64}$/, 'expected a compressed secp256k1 pubkey'),
  /** From the member's node, description `kitty-bind:v2:<tripTag>:<pubkey>` (step 3). Never paid. */
  bindInvoice: Bolt11Schema,
  policy: PolicySchema,
});

export const PolicyUpdatedBodySchema = z.object({ policy: PolicySchema });

/**
 * The trip secret, NIP-44-encrypted with the ECDH conversation key of (author, recipient).
 * Each member writes one to itself on joining, so seed recovery finds it (D1). Its content is
 * NOT under the trip key (whoever needs it does not have it): see encodeContent.
 */
export const TripSecretSharedBodySchema = z.object({
  recipients: z
    .array(z.object({ pubkey: MemberKeySchema, ciphertext: z.string().min(1) }))
    .min(1)
    .max(32)
    .refine((r) => new Set(r.map((x) => x.pubkey)).size === r.length, 'duplicate recipient'),
});

export const MemberBlockedBodySchema = z.object({ target: MemberKeySchema });
export const MemberUnblockedBodySchema = z.object({ target: MemberKeySchema });
export const MemberLeftBodySchema = z.object({}).strict();

// ---------- expenses (D2: the invoice stays out of what the debtor signs) ----------

export const RateSchema = z.object({
  /** "USD/VND": units of the second per 1 of the first. */
  pair: z.string().regex(/^[A-Z]{3}\/[A-Z]{3}$/),
  value: z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal string like "26350.5"'),
  asOf: z.iso.datetime(),
  source: z.string().min(1),
  /** Signed blob of the oracle, when there is one (step 5). */
  proof: z.string().min(1).optional(),
});
export type Rate = z.output<typeof RateSchema>;

export const ProposalLineSchema = z.object({
  debtor: MemberKeySchema,
  amount: PositiveAmountSchema,
  /** Receipt items this debtor shares. */
  itemIndexes: z.array(z.number().int().nonnegative()).min(1),
});

/**
 * What the debtors sign at the table: lines, amounts and rate, never an invoice. The payer's
 * own share is included so anyone recomputes the split from receipt, indexes and rate.
 */
export const ProposalSchema = z.object({
  tripId: TripIdSchema,
  expenseId: ExpenseIdSchema,
  payer: MemberKeySchema,
  receipt: ReceiptSchema,
  rate: RateSchema,
  assetId: z.string().min(1),
  assetDecimals: z.number().int().min(0).max(18),
  total: PositiveAmountSchema,
  payerAmount: AmountSchema,
  payerItemIndexes: z.array(z.number().int().nonnegative()),
  lines: z.array(ProposalLineSchema).min(1),
});
export type Proposal = z.output<typeof ProposalSchema>;

export const TableSignatureSchema = z.object({
  signer: MemberKeySchema,
  /** Schnorr of `signer` on proposalDigest(proposal). */
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

/** Attached by the payer; replaceable by INVOICE_REISSUED without touching any table signature. */
export const LineInvoiceSchema = z.object({ debtor: MemberKeySchema, bolt11: Bolt11Schema });

export const ExpenseSubmittedBodySchema = z.object({
  proposal: ProposalSchema,
  tableSignatures: z.array(TableSignatureSchema),
  invoices: z.array(LineInvoiceSchema).min(1),
  /** The photo stays on the payer's phone; only its hash is committed. */
  receiptImageSha256: HashHexSchema,
  fingerprint: HashHexSchema,
});

const RefExpense = z.object({ expenseRef: EventRefSchema });

export const LineSeenBodySchema = RefExpense;

export const LineDecidedBodySchema = RefExpense.extend({
  decision: z.enum(['approve', 'contest']),
  amount: PositiveAmountSchema,
  reason: z.string().min(1).optional(),
});

const PaymentCommon = RefExpense.extend({
  creditor: MemberKeySchema,
  amount: PositiveAmountSchema,
});
export const PaymentMadeBodySchema = z.discriminatedUnion('rail', [
  PaymentCommon.extend({
    rail: z.literal('ln'),
    paymentHash: HashHexSchema,
    preimage: PreimageHexSchema,
  }),
  PaymentCommon.extend({ rail: z.literal('onchain'), txid: TxidSchema }),
]);

export const ExpenseVoidedBodySchema = RefExpense;

/**
 * A vote on a contested line by a member who is neither its creditor nor its debtor (23/10,
 * provisional): the line is due, or voided. The majority rule is in the ledger, in one place.
 */
export const LineVotedBodySchema = RefExpense.extend({
  debtor: MemberKeySchema,
  outcome: z.enum(['due', 'voided']),
});

export const InvoiceReissuedBodySchema = RefExpense.extend({
  debtor: MemberKeySchema,
  bolt11: Bolt11Schema,
});

export const CheckpointBodySchema = z.object({
  /** Heads of the author's closed set, sorted. */
  frontier: z.array(EventRefSchema).min(1),
  count: z.number().int().positive(),
  /** stateHash of the fixed order (packages/ledger/src/order.ts). */
  stateHash: HashHexSchema,
});

// ---------- types ----------

const bodies = {
  TRIP_CREATED: TripCreatedBodySchema,
  MEMBER_INVITED: MemberInvitedBodySchema,
  MEMBER_JOINED: MemberJoinedBodySchema,
  TRIP_SECRET_SHARED: TripSecretSharedBodySchema,
  POLICY_UPDATED: PolicyUpdatedBodySchema,
  EXPENSE_SUBMITTED: ExpenseSubmittedBodySchema,
  LINE_SEEN: LineSeenBodySchema,
  LINE_DECIDED: LineDecidedBodySchema,
  PAYMENT_MADE: PaymentMadeBodySchema,
  EXPENSE_VOIDED: ExpenseVoidedBodySchema,
  INVOICE_REISSUED: InvoiceReissuedBodySchema,
  LINE_VOTED: LineVotedBodySchema,
  MEMBER_BLOCKED: MemberBlockedBodySchema,
  MEMBER_UNBLOCKED: MemberUnblockedBodySchema,
  MEMBER_LEFT: MemberLeftBodySchema,
  CHECKPOINT: CheckpointBodySchema,
} as const;

export type EventType = keyof typeof bodies;
export const EVENT_TYPES = Object.keys(bodies) as [EventType, ...EventType[]];
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventBody<T extends EventType> = z.output<(typeof bodies)[T]>;

/** Who may write each type. Nobody is a coordinator: the ledger checks these roles (step 2). */
export const EVENT_AUTHOR: Record<EventType, 'creator' | 'member' | 'joiner' | 'debtor' | 'payer'> =
  {
    TRIP_CREATED: 'creator',
    MEMBER_INVITED: 'member',
    MEMBER_JOINED: 'joiner',
    TRIP_SECRET_SHARED: 'member',
    POLICY_UPDATED: 'member',
    EXPENSE_SUBMITTED: 'payer',
    LINE_SEEN: 'debtor',
    LINE_DECIDED: 'debtor',
    PAYMENT_MADE: 'debtor',
    EXPENSE_VOIDED: 'payer',
    INVOICE_REISSUED: 'payer',
    LINE_VOTED: 'member',
    MEMBER_BLOCKED: 'member',
    MEMBER_UNBLOCKED: 'member',
    MEMBER_LEFT: 'member',
    CHECKPOINT: 'member',
  };

function contentOf<T extends EventType>(type: T) {
  return z.object({
    v: z.literal(2),
    tripId: TripIdSchema,
    type: z.literal(type),
    body: bodies[type],
  });
}

/** What the trip key encrypts: `{ v: 2, tripId, type, body }`, canonical JSON. */
export const RegistryContentSchema = z.discriminatedUnion('type', [
  contentOf('TRIP_CREATED'),
  contentOf('MEMBER_INVITED'),
  contentOf('MEMBER_JOINED'),
  contentOf('TRIP_SECRET_SHARED'),
  contentOf('POLICY_UPDATED'),
  contentOf('EXPENSE_SUBMITTED'),
  contentOf('LINE_SEEN'),
  contentOf('LINE_DECIDED'),
  contentOf('PAYMENT_MADE'),
  contentOf('EXPENSE_VOIDED'),
  contentOf('INVOICE_REISSUED'),
  contentOf('LINE_VOTED'),
  contentOf('MEMBER_BLOCKED'),
  contentOf('MEMBER_UNBLOCKED'),
  contentOf('MEMBER_LEFT'),
  contentOf('CHECKPOINT'),
]);
export type RegistryContent = z.output<typeof RegistryContentSchema>;
export type RegistryContentOf<T extends EventType> = Extract<RegistryContent, { type: T }>;

// ---------- encoding ----------

export class RegistryFormatError extends Error {
  override readonly name = 'RegistryFormatError';
}

/**
 * The JSON a content travels as: canonical, bigint as strings. TRIP_SECRET_SHARED leaves out
 * the trip id, because it travels in clear (encodeContent).
 */
function contentJson(c: RegistryContent): string {
  const encoded = z.encode(RegistryContentSchema, c);
  return c.type === 'TRIP_SECRET_SHARED'
    ? canonicalize({ v: encoded.v, type: encoded.type, body: encoded.body })
    : canonicalize(encoded);
}

/**
 * The `content` string of a kind-7345 event. Always NIP-44 under the trip key, except
 * TRIP_SECRET_SHARED, which is plain canonical JSON: whoever needs it has no trip key yet, and
 * its recipients' ciphertexts are the protection. base64 never starts with "{", so the two
 * cannot be confused.
 */
export function encodeContent(c: RegistryContent, tripKey: Uint8Array): string {
  const json = contentJson(c);
  return c.type === 'TRIP_SECRET_SHARED' ? json : nip44Encrypt(json, tripKey);
}

/**
 * Inverse of encodeContent. `tripId` fills in what TRIP_SECRET_SHARED leaves out and is
 * checked against every other content. One meaning, one encoding: the content must be
 * exactly what encodeContent writes (canonical JSON, no unknown fields), or it is refused.
 * Throws RegistryFormatError on anything off.
 */
export function decodeContent(
  content: string,
  tripKey: Uint8Array,
  tripId: string,
): RegistryContent {
  const clear = content.startsWith('{');
  let json = content;
  if (!clear) {
    try {
      json = nip44Decrypt(content, tripKey);
    } catch (e) {
      throw new RegistryFormatError(`cannot decrypt: ${e instanceof Nip44Error ? e.message : e}`);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new RegistryFormatError('content is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new RegistryFormatError('content is not an object');
  const isShare = (raw as { type?: unknown }).type === 'TRIP_SECRET_SHARED';
  if (clear !== isShare)
    throw new RegistryFormatError('TRIP_SECRET_SHARED, and only it, travels in clear');
  const parsed = RegistryContentSchema.safeParse(clear ? { ...raw, tripId } : raw);
  if (!parsed.success) throw new RegistryFormatError(`invalid content: ${parsed.error.message}`);
  if (parsed.data.tripId !== tripId) throw new RegistryFormatError('event of another trip');
  if (contentJson(parsed.data) !== json)
    throw new RegistryFormatError('content is not canonical JSON or has unknown fields');
  return parsed.data;
}

/** A registry event, checked and decoded. Signature and id are checked by the caller (verifyNostrEvent). */
export interface RegistryEvent {
  id: string;
  author: string;
  /** Informational only. */
  createdAt: number;
  parents: string[];
  content: RegistryContent;
}

/** Unsigned kind-7345 event; sign its id with crypto.ts and add `id` and `sig`. */
export function buildRegistryEvent(p: {
  author: string;
  createdAt: number;
  tripTag: string;
  parents: readonly string[];
  content: RegistryContent;
  tripKey: Uint8Array;
}): UnsignedNostrEvent {
  if (p.content.type === 'TRIP_CREATED' ? p.parents.length > 0 : p.parents.length === 0)
    throw new RegistryFormatError('TRIP_CREATED and only it has no parents');
  return {
    pubkey: p.author,
    created_at: p.createdAt,
    kind: KIND_REGISTRY,
    tags: registryTags(p.tripTag, p.parents),
    content: encodeContent(p.content, p.tripKey),
  };
}

/** Structure of a kind-7345 event of this trip: kind, tags, content. */
export function readRegistryEvent(
  e: NostrEvent,
  trip: { tripTag: string; tripKey: Uint8Array; tripId: string },
): RegistryEvent {
  if (e.kind !== KIND_REGISTRY) throw new RegistryFormatError(`kind ${e.kind} is not the registry`);
  let tags;
  try {
    tags = parseRegistryTags(e.tags);
  } catch (err) {
    throw new RegistryFormatError(err instanceof NostrFormatError ? err.message : String(err));
  }
  if (tags.tripTag !== trip.tripTag) throw new RegistryFormatError('event of another trip');
  const content = decodeContent(e.content, trip.tripKey, trip.tripId);
  if ((content.type === 'TRIP_CREATED') !== (tags.parents.length === 0))
    throw new RegistryFormatError('TRIP_CREATED and only it has no parents');
  return { id: e.id, author: e.pubkey, createdAt: e.created_at, parents: tags.parents, content };
}

// ---------- signatures at the table (D2) ----------

/**
 * What a debtor signs at the table: sha256("kitty:share:v1" ‖ canonical(proposal)), hex. The
 * proposal has no invoice, so reissuing one never invalidates a signature.
 */
export function proposalDigest(proposal: Proposal): string {
  return sha256Hex(`kitty:share:v1${canonicalize(z.encode(ProposalSchema, proposal))}`);
}
