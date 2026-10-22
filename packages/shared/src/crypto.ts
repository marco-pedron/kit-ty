// OWNED BY STREAM B (PLAN.md §2). Stream A wrote only the interface and the dev fakes.
// Two formats while the registry migrates (docs/ADR-001-formato-eventi.md):
// - the demo registry (gate 2, SPEC §9.1, §20): ed25519 signatures of the app key, bound to
//   the node by an invoice;
// - registry v2 on Nostr: BIP-340 Schnorr on secp256k1 over 32-byte digests (event ids,
//   table-signature digests), the per-trip registry key as author.
// Never RLN /signmessage (it signs the empty string in d4762ac).
// Re-exported by index.ts and bundled into the web app: no node:crypto, no Buffer.
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
import type { DecodedInvoice } from './domain.js';
import { apiError } from './errors.js';

/** Used by relay and ledger (validateEvent); pure TypeScript, no node needed (SPEC §14.2). */
export interface SignatureVerifier {
  verify(authorPubkey: string, message: string, signature: string): boolean;
}

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  readonly error = apiError('NOT_IMPLEMENTED', this.message);
}

const PUBKEY_HEX = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;

/**
 * The real verifier. Wire format: `authorPubkey` = 32-byte ed25519 key and `signature` =
 * 64 bytes, both lowercase hex; the signed bytes are the UTF-8 of `message`. Strict RFC 8032
 * (no ZIP-215 leniency), so relay, agents and web accept exactly the same signatures.
 * Never throws: malformed input is just an invalid signature.
 */
export const signatureVerifier: SignatureVerifier = {
  verify(authorPubkey: string, message: string, signature: string): boolean {
    try {
      if (typeof authorPubkey !== 'string' || typeof message !== 'string') return false;
      if (typeof signature !== 'string') return false;
      if (!PUBKEY_HEX.test(authorPubkey) || !SIG_HEX.test(signature)) return false;
      return ed25519.verify(hexToBytes(signature), utf8ToBytes(message), hexToBytes(authorPubkey), {
        zip215: false,
      });
    } catch {
      return false;
    }
  },
};

/** The ed25519 public key (lowercase hex) of a 32-byte secret key given as lowercase hex. */
export function ed25519PublicKeyHex(secretHex: string): string {
  if (!PUBKEY_HEX.test(secretHex)) throw new Error('ed25519 secret must be 64 lowercase hex chars');
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secretHex)));
}

/** Signs the UTF-8 bytes of `message`; the result is what signatureVerifier accepts. */
export function ed25519Sign(secretHex: string, message: string): string {
  if (!PUBKEY_HEX.test(secretHex)) throw new Error('ed25519 secret must be 64 lowercase hex chars');
  return bytesToHex(ed25519.sign(utf8ToBytes(message), hexToBytes(secretHex)));
}

// ---------- registry v2: BIP-340 Schnorr (Nostr, NIP-01) ----------

const SCHNORR_SIG_HEX = /^[0-9a-f]{128}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/**
 * Schnorr verifier of registry v2. Wire format: `authorPubkey` = 32-byte x-only key,
 * `message` = a 32-byte digest as 64 lowercase hex (the NIP-01 event id, or the digest of a
 * proposal signed at the table), `signature` = 64 bytes; all lowercase hex. The signed bytes
 * are the 32 raw bytes of the digest, as BIP-340 and NIP-01 specify. Other message lengths are
 * refused: we only ever sign digests. Never throws.
 */
export const schnorrVerifier: SignatureVerifier = {
  verify(authorPubkey: string, message: string, signature: string): boolean {
    try {
      if (typeof authorPubkey !== 'string' || typeof message !== 'string') return false;
      if (typeof signature !== 'string') return false;
      if (!PUBKEY_HEX.test(authorPubkey) || !DIGEST_HEX.test(message)) return false;
      if (!SCHNORR_SIG_HEX.test(signature)) return false;
      return schnorr.verify(hexToBytes(signature), hexToBytes(message), hexToBytes(authorPubkey));
    } catch {
      return false;
    }
  },
};

/** The x-only Schnorr public key (lowercase hex) of a 32-byte secp256k1 secret key in hex. */
export function schnorrPublicKeyHex(secretHex: string): string {
  if (!PUBKEY_HEX.test(secretHex))
    throw new Error('secp256k1 secret must be 64 lowercase hex chars');
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
}

/** Signs a 32-byte digest given as hex (fresh aux randomness); schnorrVerifier accepts it. */
export function schnorrSign(secretHex: string, digestHex: string): string {
  if (!PUBKEY_HEX.test(secretHex))
    throw new Error('secp256k1 secret must be 64 lowercase hex chars');
  if (!DIGEST_HEX.test(digestHex)) throw new Error('digest must be 64 lowercase hex chars');
  return bytesToHex(schnorr.sign(hexToBytes(digestHex), hexToBytes(secretHex)));
}

/**
 * The bind invoice of MEMBER_JOINED (SPEC §9.1): created by the member's own node with
 * description `kitty-bind:<sha256Hex(appPubkey)>`, so its payee_pubkey ties the app key to
 * the node. The caller decodes the bolt11; this only checks the decoded fields.
 */
export function checkBindInvoice(
  decoded: DecodedInvoice,
  appPubkey: string,
  nodePubkey: string,
): boolean {
  if (typeof appPubkey !== 'string' || !PUBKEY_HEX.test(appPubkey)) return false;
  return (
    decoded.description === `kitty-bind:${sha256Hex(appPubkey)}` &&
    decoded.payeePubkey === nodePubkey
  );
}

// ---------- dev fakes (KITTY_FAKES=1 only) ----------
// A fake signature is sha256("kitty-fake-sig:" + pubkey + ":" + message): anyone can forge it,
// which is why both functions refuse to run unless fakes are on.

function assertFakesOn(): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.KITTY_FAKES !== '1')
    throw new Error('fakeSign/fakeVerify need KITTY_FAKES=1: they are forgeable by design');
}

export function fakeSign(authorPubkey: string, message: string): string {
  assertFakesOn();
  return sha256Hex(`kitty-fake-sig:${authorPubkey}:${message}`);
}

export function fakeVerify(authorPubkey: string, message: string, signature: string): boolean {
  assertFakesOn();
  return sha256Hex(`kitty-fake-sig:${authorPubkey}:${message}`) === signature;
}

export const fakeVerifier: SignatureVerifier = { verify: fakeVerify };
