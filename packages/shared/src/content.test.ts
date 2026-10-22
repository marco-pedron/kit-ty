import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { v2 as nostrToolsNip44 } from 'nostr-tools/nip44';
import { describe, expect, it } from 'vitest';
import {
  newTripSecret,
  nip44Decrypt,
  nip44Encrypt,
  Nip44Error,
  openTripSecret,
  sealTripSecret,
  tripContentKey,
  tripTagOf,
} from './content.js';

describe('NIP-44 v2', () => {
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
