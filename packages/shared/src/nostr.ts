import { z } from 'zod';
import { sha256Hex } from './canonical.js';
import type { SignatureVerifier } from './crypto.js';
import { Hex32Schema } from './ids.js';

// NIP-01 envelope of the trip registry (docs/ADR-001-formato-eventi.md). This file only knows
// the wire format: serialization, id, tags. Signing and Schnorr verification live in crypto.ts
// (stream B) and come in as a SignatureVerifier; what the content means is events.ts.

/** Regular kind (1000-9999, stored by relays): every registry event. */
export const KIND_REGISTRY = 7345;
/** Ephemeral kind (20000-29999, not stored): presence and "need" requests, never applied. */
export const KIND_EPHEMERAL = 27345;
/** Parents per event (`e` tags), so a hostile author cannot make others walk huge tag lists. */
export const MAX_PARENTS = 32;

/** BIP-340 x-only public key: the per-trip registry key of a member (NIP-06, step 3). */
export const XOnlyPubkeySchema = Hex32Schema;
export const NostrIdSchema = Hex32Schema;
export const SchnorrSigSchema = z
  .string()
  .regex(/^[0-9a-f]{128}$/, 'expected 64 bytes of lowercase hex');

export const NostrTagSchema = z.array(z.string()).min(1);

export const UnsignedNostrEventSchema = z.object({
  pubkey: XOnlyPubkeySchema,
  /** Unix seconds. Informational only: never used for ordering (ADR-001 §4). */
  created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.number().int().min(0).max(65535),
  tags: z.array(NostrTagSchema),
  content: z.string(),
});
export type UnsignedNostrEvent = z.output<typeof UnsignedNostrEventSchema>;

export const NostrEventSchema = UnsignedNostrEventSchema.extend({
  id: NostrIdSchema,
  sig: SchnorrSigSchema,
});
export type NostrEvent = z.output<typeof NostrEventSchema>;

export class NostrFormatError extends Error {
  override readonly name = 'NostrFormatError';
}

// NIP-01 escapes \n \" \\ \r \t \b \f and keeps everything else verbatim; JSON.stringify
// (what nostr-tools and most clients hash) also escapes the other C0 controls as \u00XX and
// lone surrogates as \uDXXX. The two agree on every string without those characters, so we
// refuse them: an id never depends on which reading a client picked.
// eslint-disable-next-line no-control-regex
const AMBIGUOUS = /[\u0000-\u0007\u000b\u000e-\u001f]|\p{Surrogate}/u;

function checkString(s: string, where: string): void {
  if (AMBIGUOUS.test(s))
    throw new NostrFormatError(`${where}: control character or lone surrogate`);
}

/** The exact UTF-8 string NIP-01 hashes into the id: `[0,pubkey,created_at,kind,tags,content]`. */
export function serializeForId(e: UnsignedNostrEvent): string {
  const u = UnsignedNostrEventSchema.parse(e);
  u.tags.forEach((t, i) => t.forEach((s, j) => checkString(s, `tags[${i}][${j}]`)));
  checkString(u.content, 'content');
  return JSON.stringify([0, u.pubkey, u.created_at, u.kind, u.tags, u.content]);
}

/** sha256 of serializeForId, lowercase hex. Also the 32-byte message the Schnorr sig signs. */
export function nostrEventId(e: UnsignedNostrEvent): string {
  return sha256Hex(serializeForId(e));
}

/** The id matches the fields. False on any malformed input, never throws. */
export function hasValidId(e: NostrEvent): boolean {
  try {
    return nostrEventId(e) === e.id;
  } catch {
    return false;
  }
}

/**
 * Id and signature. `verifier` is crypto.ts's Schnorr verifier: message = the id as 64 hex,
 * signed as its 32 raw bytes (BIP-340, NIP-01).
 */
export function verifyNostrEvent(e: NostrEvent, verifier: SignatureVerifier): boolean {
  return hasValidId(e) && verifier.verify(e.pubkey, e.id, e.sig);
}

// ---------- tags of the registry (ADR-001 §2) ----------

/** `["T", tripTag]`: the trip address relays filter on, without learning the trip id. */
export const TRIP_TAG = 'T';
/** `["e", id]`: one per parent. */
export const PARENT_TAG = 'e';

export interface RegistryTags {
  tripTag: string;
  /** Sorted, unique. Empty only for TRIP_CREATED. */
  parents: string[];
}

/** Tags of a registry event, in the one order we write them: T first, then sorted parents. */
export function registryTags(tripTag: string, parents: readonly string[]): string[][] {
  const t = parseRegistryTags([
    [TRIP_TAG, tripTag],
    ...[...new Set(parents)].sort().map((p) => [PARENT_TAG, p]),
  ]);
  return [[TRIP_TAG, t.tripTag], ...t.parents.map((p) => [PARENT_TAG, p])];
}

/**
 * Strict reading of the tags of a kind-7345 event: exactly one `T` tag, `e` tags with a single
 * 32-byte hex id each, no duplicates, at most MAX_PARENTS, nothing else. Extra tags are refused
 * rather than ignored: nothing outside the signed content may carry meaning.
 */
export function parseRegistryTags(tags: readonly (readonly string[])[]): RegistryTags {
  let tripTag: string | undefined;
  const parents = new Set<string>();
  for (const tag of tags) {
    const [name, value, ...rest] = tag;
    if (value === undefined || rest.length > 0 || !Hex32Schema.safeParse(value).success)
      throw new NostrFormatError(`malformed tag ${JSON.stringify(tag)}`);
    if (name === TRIP_TAG) {
      if (tripTag !== undefined) throw new NostrFormatError('more than one T tag');
      tripTag = value;
    } else if (name === PARENT_TAG) {
      if (parents.has(value)) throw new NostrFormatError(`duplicate parent ${value}`);
      parents.add(value);
    } else {
      throw new NostrFormatError(`unexpected tag ${JSON.stringify(name)}`);
    }
  }
  if (tripTag === undefined) throw new NostrFormatError('missing T tag');
  if (parents.size > MAX_PARENTS) throw new NostrFormatError(`more than ${MAX_PARENTS} parents`);
  return { tripTag, parents: [...parents].sort() };
}
