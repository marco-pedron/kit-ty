import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { openTripSecret } from './content.js';
import { schnorrVerifier } from './crypto.js';
import type { DecodedInvoice } from './domain.js';
import {
  KIND_REGISTRY,
  NostrFormatError,
  parseRegistryTags,
  verifyNostrEvent,
  type NostrEvent,
} from './nostr.js';

// The registry key of a member for one trip (step 3, docs/ADR-001-formato-eventi.md §2 and
// plan §4): NIP-06 m/44'/1237'/<i>'/0/0 on the 64-byte BIP-39 seed, one account `i` per trip,
// derivable offline. Hardened accounts: two trips of the same person share no key material a
// relay could link. The index is a local counter (0 for the first trip), never derived from
// the trip id, so a seed alone finds every trip again (recoverTrips).

export class RegistryKeyError extends Error {
  override readonly name = 'RegistryKeyError';
}

/** Highest NIP-06 account (hardened index). */
export const MAX_REGISTRY_INDEX = 0x7fff_ffff;

/** Unused indexes in a row after which recovery stops (gap limit, as BIP-44). */
export const RECOVERY_GAP = 5;

export interface RegistryKey {
  index: number;
  /** 32-byte secret key, hex. */
  secret: string;
  /** x-only public key, hex: the `pubkey` of every event of this member in that trip. */
  pubkey: string;
}

export function registryKeyPath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_REGISTRY_INDEX)
    throw new RegistryKeyError(`registry index ${index} is not in 0..${MAX_REGISTRY_INDEX}`);
  return `m/44'/1237'/${index}'/0/0`;
}

/** BIP-39 English mnemonic → 64-byte seed, empty passphrase (the seed of the member's node). */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
  const words = mnemonic.normalize('NFKD').trim().split(/\s+/u).join(' ');
  if (!validateMnemonic(words, wordlist)) throw new RegistryKeyError('not a valid BIP-39 mnemonic');
  return mnemonicToSeedSync(words, '');
}

export function registryKey(seed: Uint8Array, index: number): RegistryKey {
  if (seed.length !== 64) throw new RegistryKeyError('expected the 64-byte BIP-39 seed');
  const key = HDKey.fromMasterSeed(seed).derive(registryKeyPath(index)).privateKey;
  if (key === null) throw new RegistryKeyError(`no private key at index ${index}`);
  return { index, secret: bytesToHex(key), pubkey: bytesToHex(schnorr.getPublicKey(key)) };
}

/** The index of a new trip: one past the highest in use. */
export function nextRegistryIndex(used: readonly number[]): number {
  return used.length === 0 ? 0 : Math.max(...used) + 1;
}

export interface RecoveredTrip {
  tripTag: string;
  tripSecret: string;
}

/**
 * The trip secrets a member wrote to itself (TRIP_SECRET_SHARED, ADR-001 §3) among `events`:
 * only valid kind-7345 events authored by `key`, with a recipient entry for `key` that opens to
 * the secret of the event's T tag. Anything else is ignored: the events come from relays.
 */
export function tripSecretsOf(key: RegistryKey, events: readonly NostrEvent[]): RecoveredTrip[] {
  const found = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== KIND_REGISTRY || e.pubkey !== key.pubkey || !e.content.startsWith('{')) continue;
    if (!verifyNostrEvent(e, schnorrVerifier)) continue;
    let tripTag: string;
    let raw: unknown;
    try {
      tripTag = parseRegistryTags(e.tags).tripTag;
      raw = JSON.parse(e.content);
    } catch (err) {
      if (err instanceof NostrFormatError || err instanceof SyntaxError) continue;
      throw err;
    }
    const share = raw as { type?: unknown; body?: { recipients?: unknown } };
    if (share.type !== 'TRIP_SECRET_SHARED' || !Array.isArray(share.body?.recipients)) continue;
    for (const r of share.body.recipients as { pubkey?: unknown; ciphertext?: unknown }[]) {
      if (r.pubkey !== key.pubkey || typeof r.ciphertext !== 'string') continue;
      const secret = openTripSecret(r.ciphertext, key.secret, key.pubkey, tripTag);
      if (secret !== null) found.set(tripTag, secret);
    }
  }
  return [...found].map(([tripTag, tripSecret]) => ({ tripTag, tripSecret }));
}

export interface RecoveredIndex {
  key: RegistryKey;
  trips: RecoveredTrip[];
}

/**
 * Recovery from the seed alone: derives the keys i = 0, 1, 2… and asks `eventsBy` for the
 * events of each, until `gap` indexes in a row have none. Returns the indexes in use with the
 * trip secrets found among their own events. `eventsBy` is the network part (one relay query
 * per key, step 4); here it is injected.
 */
export async function recoverTrips(
  seed: Uint8Array,
  eventsBy: (pubkey: string) => Promise<readonly NostrEvent[]> | readonly NostrEvent[],
  gap = RECOVERY_GAP,
): Promise<RecoveredIndex[]> {
  const out: RecoveredIndex[] = [];
  for (let i = 0, empty = 0; empty < gap && i <= MAX_REGISTRY_INDEX; i++) {
    const key = registryKey(seed, i);
    const events = await eventsBy(key.pubkey);
    if (events.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    out.push({ key, trips: tripSecretsOf(key, events) });
  }
  return out;
}

// ---------- the bind invoice (kitty-bind:v2) ----------

/** Description of the bind invoice of MEMBER_JOINED: commits to the trip and the registry key. */
export function bindDescriptionV2(tripTag: string, registryPubkey: string): string {
  return `kitty-bind:v2:${tripTag}:${registryPubkey}`;
}

/**
 * Null when the decoded bind invoice ties `nodePubkey` to `registryPubkey` in the trip of
 * `tripTag`, otherwise why not. Its expiry does not count: it is a signature by the node, never
 * paid. The caller decodes the bolt11 (the BOLT11 signature is checked by the decoder).
 */
export function bindInvoiceRefusal(
  decoded: Pick<DecodedInvoice, 'payeePubkey' | 'description'>,
  p: { tripTag: string; registryPubkey: string; nodePubkey: string },
): string | null {
  if (decoded.payeePubkey !== p.nodePubkey) return 'bind invoice is from another node';
  if (decoded.description !== bindDescriptionV2(p.tripTag, p.registryPubkey))
    return 'bind invoice does not commit to this trip and key';
  return null;
}
