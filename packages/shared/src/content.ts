import { chacha20 } from '@noble/ciphers/chacha.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { expand, extract, hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js';

// Encrypted content of the registry (decision D1, docs/ADR-001-formato-eventi.md §3).
// NIP-44 v2 exactly as specified (tested on its official vectors), used two ways:
// - registry events: the conversation key is derived from the trip secret, so every member
//   and nobody else reads them;
// - TRIP_SECRET_SHARED: the trip secret encrypted to one member with the standard ECDH
//   conversation key, so whoever recovers the seed recovers the secret.
// Re-exported by index.ts and bundled into the web app: no node:crypto, no Buffer.

export class Nip44Error extends Error {
  override readonly name = 'Nip44Error';
}

const VERSION = 2;
// NIP-44 now allows plaintexts up to 2^32 - 1 with a 6-byte prefix; its published vectors
// (sha256 269ed0f6…, the file named in 44.md) still treat 65536+ as invalid. We stay on the
// classic range, which every implementation reads: registry events are a few KB.
const MAX_PLAINTEXT = 65535;
const MAX_PAYLOAD_CHARS = 87472; // base64 of 1 + 32 + (2 + 65536) + 32 bytes
const HEX32 = /^[0-9a-f]{64}$/;

function bytes32(hex: string, what: string): Uint8Array {
  if (!HEX32.test(hex)) throw new Nip44Error(`${what} must be 32 bytes of lowercase hex`);
  return hexToBytes(hex);
}

/** NIP-44: hkdf_extract(IKM = unhashed ECDH x of (secret A, public B), salt = "nip44-v2"). */
export function nip44ConversationKey(secretHex: string, xOnlyPubkeyHex: string): Uint8Array {
  const pub = bytes32(xOnlyPubkeyHex, 'public key');
  let shared: Uint8Array;
  try {
    shared = secp256k1.getSharedSecret(
      bytes32(secretHex, 'secret key'),
      concatBytes(new Uint8Array([2]), pub),
    );
  } catch {
    throw new Nip44Error('invalid secret or public key');
  }
  return extract(sha256, shared.subarray(1, 33), utf8ToBytes('nip44-v2'));
}

function messageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  if (conversationKey.length !== 32) throw new Nip44Error('conversation key must be 32 bytes');
  if (nonce.length !== 32) throw new Nip44Error('nonce must be 32 bytes');
  const keys = expand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/** NIP-44 padded length: powers of two up to 256, then chunks of a quarter of the next one. */
export function nip44PaddedLength(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new Nip44Error('expected a positive length');
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const raw = utf8ToBytes(plaintext);
  const len = raw.length;
  if (len < 1 || len > MAX_PLAINTEXT) throw new Nip44Error('plaintext must be 1 to 65535 bytes');
  const prefix = new Uint8Array([len >> 8, len & 0xff]);
  return concatBytes(prefix, raw, new Uint8Array(nip44PaddedLength(len) - len));
}

function unpad(padded: Uint8Array): string {
  const len = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0);
  const raw = padded.subarray(2, 2 + len);
  if (len === 0 || raw.length !== len || padded.length !== 2 + nip44PaddedLength(len))
    throw new Nip44Error('invalid padding');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Nip44Error('invalid UTF-8');
  }
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Nip44Error('AAD must be 32 bytes');
  return hmac(sha256, key, concatBytes(aad, message));
}

function toBase64(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new Nip44Error('invalid base64');
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** NIP-44 v2 payload (base64). `nonce` only for test vectors: production draws 32 random bytes. */
export function nip44Encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  return toBase64(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac));
}

export function nip44Decrypt(payload: string, conversationKey: Uint8Array): string {
  if (typeof payload !== 'string') throw new Nip44Error('payload must be a string');
  if (payload.startsWith('#')) throw new Nip44Error('unknown encryption version');
  if (payload.length < 132 || payload.length > MAX_PAYLOAD_CHARS)
    throw new Nip44Error('invalid payload length');
  const data = fromBase64(payload);
  if (data.length < 99) throw new Nip44Error('invalid data length');
  if (data[0] !== VERSION) throw new Nip44Error(`unknown encryption version ${data[0]}`);
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversationKey, nonce);
  if (!equalBytes(hmacAad(hmacKey, ciphertext, nonce), mac)) throw new Nip44Error('invalid MAC');
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

// ---------- trip keys (ADR-001 §3) ----------
// tripSecret: 32 random bytes made by whoever creates the trip and handed over with the
// invite. It never touches money: it only addresses and decrypts the registry.

/** `T` tag of every event of the trip: hex(sha256("kitty:trip:v1" ‖ tripSecret)). */
export function tripTagOf(tripSecretHex: string): string {
  return bytesToHex(
    sha256(concatBytes(utf8ToBytes('kitty:trip:v1'), bytes32(tripSecretHex, 'trip secret'))),
  );
}

/** NIP-44 conversation key shared by the members: HKDF-SHA256(tripSecret, info "kitty:content:v1"). */
export function tripContentKey(tripSecretHex: string): Uint8Array {
  return hkdf(
    sha256,
    bytes32(tripSecretHex, 'trip secret'),
    undefined,
    utf8ToBytes('kitty:content:v1'),
    32,
  );
}

export function newTripSecret(): string {
  return bytesToHex(randomBytes(32));
}

/**
 * The trip secret for TRIP_SECRET_SHARED: NIP-44 with the ECDH conversation key of the author
 * and one recipient (the author itself, for seed recovery).
 */
export function sealTripSecret(
  tripSecretHex: string,
  authorSecretHex: string,
  recipientPubkeyHex: string,
): string {
  bytes32(tripSecretHex, 'trip secret');
  return nip44Encrypt(tripSecretHex, nip44ConversationKey(authorSecretHex, recipientPubkeyHex));
}

/** Opens a sealed trip secret and checks it is the secret of `tripTag`; null if not. */
export function openTripSecret(
  ciphertext: string,
  recipientSecretHex: string,
  authorPubkeyHex: string,
  tripTag: string,
): string | null {
  try {
    const secret = nip44Decrypt(
      ciphertext,
      nip44ConversationKey(recipientSecretHex, authorPubkeyHex),
    );
    return HEX32.test(secret) && tripTagOf(secret) === tripTag ? secret : null;
  } catch {
    return null;
  }
}
