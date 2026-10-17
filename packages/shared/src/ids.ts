import { z } from 'zod';

// Who is who (CLAUDE.md rule 8): three travelers and one coordinator.
export const MemberIdSchema = z.enum(['alice', 'bob', 'charlie']);
export type MemberId = z.infer<typeof MemberIdSchema>;
export const MEMBER_IDS = MemberIdSchema.options;

export const CoordinatorIdSchema = z.literal('dave');
export type CoordinatorId = z.infer<typeof CoordinatorIdSchema>;

/** The `:as` of every agent route and `?as=` of the web app. */
export const ActorIdSchema = z.enum(['alice', 'bob', 'charlie', 'dave']);
export type ActorId = z.infer<typeof ActorIdSchema>;

export const RoleSchema = z.enum(['traveler', 'coordinator']);
export type Role = z.infer<typeof RoleSchema>;

export function roleOf(actor: ActorId): Role {
  return actor === 'dave' ? 'coordinator' : 'traveler';
}

export function isMemberId(actor: string): actor is MemberId {
  return (MEMBER_IDS as readonly string[]).includes(actor);
}

// Ids travel inside invoice descriptions `kitty:<tripId>:<expenseId>:<debtor>`: no colons.
const slug = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected 1-64 chars of [A-Za-z0-9_-]');
export const TripIdSchema = slug;
export type TripId = z.infer<typeof TripIdSchema>;
export const ExpenseIdSchema = slug;
export type ExpenseId = z.infer<typeof ExpenseIdSchema>;

// Hex encodings, lowercase.
export const Hex32Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected 32 bytes of lowercase hex');
/** sha256 digests: event hashes, payment hashes, image hashes, fingerprints. */
export const HashHexSchema = Hex32Schema;
export const PreimageHexSchema = Hex32Schema;
/** 16 random bytes, unique per trip (anti-replay, SPEC §9.1). */
export const NonceHexSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'expected 16 bytes of lowercase hex');

/** ed25519 public key of the app: the `author` of events with the rln-rest engine (SPEC §9.1). */
export const AppPubkeySchema = Hex32Schema;
/** secp256k1 compressed public key of a Lightning node: the `payee_pubkey` of its invoices. */
export const NodePubkeySchema = z
  .string()
  .regex(/^0[23][0-9a-f]{64}$/, 'expected a compressed secp256k1 pubkey in hex');
/**
 * An event author / member identity. With `rln-rest` (chosen, SPEC §20) it is the appPubkey;
 * the `wdk` engine would use the nodePubkey. Every `*Pubkey` field of an event body that names
 * a member (debtorPubkey, creditorPubkey, memberPubkey) is this, never the node key.
 */
export const PubkeySchema = z.union([AppPubkeySchema, NodePubkeySchema]);
export type Pubkey = z.infer<typeof PubkeySchema>;

export const TxidSchema = Hex32Schema;
export const Bolt11Schema = z.string().regex(/^ln[a-z0-9]+$/i, 'expected a BOLT11 invoice');
