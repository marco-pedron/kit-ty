// OWNED BY STREAM B (PLAN.md §2). Stream A wrote only the interface and the dev fakes.
// Format chosen at gate 2 (SPEC §9.1, §20): ed25519 signatures of the app key, bound to the
// node by an invoice. Never RLN /signmessage (it signs the empty string in d4762ac).
// Re-exported by index.ts and bundled into the web app: no node:crypto, no Buffer.
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
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
