import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { v2 as nostrToolsNip44 } from 'nostr-tools/nip44';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './canonical.js';
import {
  newTripSecret,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  Nip44Error,
  nip44PaddedLength,
  openTripSecret,
  sealTripSecret,
  tripContentKey,
  tripTagOf,
} from './content.js';

// Official NIP-44 vectors: https://github.com/paulmillr/nip44/blob/main/nip44.vectors.json,
// the file whose sha256 is published in NIP-44 (44.md, "Tests and code").
const raw = readFileSync(new URL('./test/vectors/nip44.vectors.json', import.meta.url), 'utf8');
const VECTORS_SHA256 = '269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040';

interface Vectors {
  v2: {
    valid: {
      get_conversation_key: { sec1: string; pub2: string; conversation_key: string }[];
      calc_padded_len: [number, number][];
      encrypt_decrypt: {
        sec1: string;
        sec2: string;
        conversation_key: string;
        nonce: string;
        plaintext: string;
        payload: string;
      }[];
      encrypt_decrypt_long_msg: {
        conversation_key: string;
        nonce: string;
        pattern: string;
        repeat: number;
        plaintext_sha256: string;
        payload_sha256: string;
      }[];
    };
    invalid: {
      encrypt_msg_lengths: number[];
      get_conversation_key: { sec1: string; pub2: string; note: string }[];
      decrypt: { conversation_key: string; nonce: string; payload: string; note: string }[];
    };
  };
}
const { valid, invalid } = (JSON.parse(raw) as Vectors).v2;

describe('NIP-44 v2 on the official vectors', () => {
  it('uses the file NIP-44 publishes', () => {
    expect(sha256Hex(raw)).toBe(VECTORS_SHA256);
  });

  it.each(valid.get_conversation_key)('conversation key $conversation_key', (v) => {
    expect(bytesToHex(nip44ConversationKey(v.sec1, v.pub2))).toBe(v.conversation_key);
  });

  it.each(valid.calc_padded_len)('padded length of %i is %i', (len, padded) => {
    expect(nip44PaddedLength(len)).toBe(padded);
  });

  it.each(valid.encrypt_decrypt)('encrypts and decrypts $plaintext', (v) => {
    const key = nip44ConversationKey(v.sec1, bytesToHex(schnorr.getPublicKey(hexToBytes(v.sec2))));
    expect(bytesToHex(key)).toBe(v.conversation_key);
    expect(nip44Encrypt(v.plaintext, key, hexToBytes(v.nonce))).toBe(v.payload);
    expect(nip44Decrypt(v.payload, key)).toBe(v.plaintext);
  });

  it.each(valid.encrypt_decrypt_long_msg)('long message $repeat × $pattern', (v) => {
    const plaintext = v.pattern.repeat(v.repeat);
    expect(sha256Hex(plaintext)).toBe(v.plaintext_sha256);
    const key = hexToBytes(v.conversation_key);
    const payload = nip44Encrypt(plaintext, key, hexToBytes(v.nonce));
    expect(sha256Hex(payload)).toBe(v.payload_sha256);
    expect(nip44Decrypt(payload, key)).toBe(plaintext);
  });

  it.each(invalid.encrypt_msg_lengths)('refuses a plaintext of %i bytes', (len) => {
    expect(() => nip44Encrypt('a'.repeat(len), new Uint8Array(32).fill(1))).toThrow(Nip44Error);
  });

  it.each(invalid.get_conversation_key)('refuses keys: $note', (v) => {
    expect(() => nip44ConversationKey(v.sec1, v.pub2)).toThrow(Nip44Error);
  });

  it.each(invalid.decrypt)('refuses payload: $note', (v) => {
    expect(() => nip44Decrypt(v.payload, hexToBytes(v.conversation_key))).toThrow(Nip44Error);
  });

  it('interoperates with nostr-tools both ways', () => {
    const key = tripContentKey(newTripSecret());
    const text = '{"v":2,"type":"LINE_SEEN"} 🍜';
    expect(nostrToolsNip44.decrypt(nip44Encrypt(text, key), key)).toBe(text);
    expect(nip44Decrypt(nostrToolsNip44.encrypt(text, key), key)).toBe(text);
  });
});

describe('trip keys', () => {
  const secret = '11'.repeat(32);

  it('derives tag and content key deterministically and independently', () => {
    expect(tripTagOf(secret)).toBe(tripTagOf(secret));
    expect(tripTagOf(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesToHex(tripContentKey(secret))).not.toBe(tripTagOf(secret));
    expect(tripTagOf('22'.repeat(32))).not.toBe(tripTagOf(secret));
  });

  it('a different trip secret cannot decrypt', () => {
    const payload = nip44Encrypt('hello', tripContentKey(secret));
    expect(() => nip44Decrypt(payload, tripContentKey('22'.repeat(32)))).toThrow(Nip44Error);
  });

  it('fresh nonce every time', () => {
    const key = tripContentKey(secret);
    expect(nip44Encrypt('hello', key)).not.toBe(nip44Encrypt('hello', key));
  });

  it('refuses a malformed secret', () => {
    expect(() => tripTagOf('11')).toThrow(Nip44Error);
    expect(() => tripContentKey('XX'.repeat(32))).toThrow(Nip44Error);
  });
});

describe('sealed trip secret (TRIP_SECRET_SHARED, D1)', () => {
  const secret = newTripSecret();
  const tag = tripTagOf(secret);
  const alice = '0'.repeat(63) + '1';
  const bob = '0'.repeat(63) + '2';
  const pub = (sk: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)));

  it('the author can seal it to itself and recover it from its key alone', () => {
    const sealed = sealTripSecret(secret, alice, pub(alice));
    expect(openTripSecret(sealed, alice, pub(alice), tag)).toBe(secret);
  });

  it('opens for the recipient, not for a third party', () => {
    const sealed = sealTripSecret(secret, alice, pub(bob));
    expect(openTripSecret(sealed, bob, pub(alice), tag)).toBe(secret);
    expect(openTripSecret(sealed, '0'.repeat(63) + '3', pub(alice), tag)).toBeNull();
  });

  it('refuses a secret that is not the one of the trip', () => {
    const sealed = sealTripSecret(newTripSecret(), alice, pub(bob));
    expect(openTripSecret(sealed, bob, pub(alice), tag)).toBeNull();
  });
});
