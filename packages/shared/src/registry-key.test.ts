import { accountFromSeedWords } from 'nostr-tools/nip06';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { newTripSecret, sealTripSecret, tripContentKey, tripTagOf } from './content.js';
import { schnorrSign } from './crypto.js';
import { buildRegistryEvent } from './events.js';
import { nostrEventId, type NostrEvent } from './nostr.js';
import {
  bindDescriptionV2,
  bindInvoiceRefusal,
  nextRegistryIndex,
  recoverTrips,
  registryKey,
  registryKeyPath,
  RegistryKeyError,
  seedFromMnemonic,
  tripSecretsOf,
  type RegistryKey,
} from './registry-key.js';

// Step 3: the registry key per trip. The official NIP-06 vectors are in
// registry-key.vectors.test.ts (downloaded); here nostr-tools is the oracle for other accounts.

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(MNEMONIC);

/** TRIP_SECRET_SHARED of `key` to itself, as each member writes on joining. */
function selfShare(key: RegistryKey, tripSecret: string, createdAt = 1_760_000_000): NostrEvent {
  const unsigned = buildRegistryEvent({
    author: key.pubkey,
    createdAt,
    tripTag: tripTagOf(tripSecret),
    parents: ['ab'.repeat(32)],
    content: {
      v: 2,
      tripId: 'unused',
      type: 'TRIP_SECRET_SHARED',
      body: {
        recipients: [
          { pubkey: key.pubkey, ciphertext: sealTripSecret(tripSecret, key.secret, key.pubkey) },
        ],
      },
    },
    tripKey: tripContentKey(tripSecret),
  });
  const id = nostrEventId(unsigned);
  return { ...unsigned, id, sig: schnorrSign(key.secret, id) };
}

describe('NIP-06 key per trip', () => {
  it("path m/44'/1237'/<i>'/0/0, one hardened account per trip", () => {
    expect(registryKeyPath(0)).toBe("m/44'/1237'/0'/0/0");
    expect(registryKeyPath(7)).toBe("m/44'/1237'/7'/0/0");
    expect(() => registryKeyPath(-1)).toThrow(RegistryKeyError);
    expect(() => registryKeyPath(2 ** 31)).toThrow(RegistryKeyError);
    expect(() => registryKeyPath(1.5)).toThrow(RegistryKeyError);
  });

  it('matches nostr-tools for several accounts', () => {
    for (const i of [0, 1, 2, 41, 2 ** 31 - 1]) {
      const theirs = accountFromSeedWords(MNEMONIC, '', i);
      const ours = registryKey(seed, i);
      expect(ours.secret).toBe(bytesToHex(theirs.privateKey));
      expect(ours.pubkey).toBe(theirs.publicKey);
    }
  });

  it('different indexes give different, unrelated keys', () => {
    const keys = Array.from({ length: 20 }, (_, i) => registryKey(seed, i));
    expect(new Set(keys.map((k) => k.pubkey)).size).toBe(20);
    expect(new Set(keys.map((k) => k.secret)).size).toBe(20);
  });

  it('refuses what is not a 64-byte seed from a valid mnemonic', () => {
    expect(() => seedFromMnemonic('abandon abandon abandon')).toThrow(RegistryKeyError);
    expect(() => registryKey(new Uint8Array(32), 0)).toThrow(RegistryKeyError);
  });

  it('the next trip takes one past the highest index in use', () => {
    expect(nextRegistryIndex([])).toBe(0);
    expect(nextRegistryIndex([0, 1, 3])).toBe(4);
  });
});

describe('recovery from the seed', () => {
  it('finds several trips of the same seed and their secrets, up to the gap limit', async () => {
    const trips = [0, 1, 4].map((i) => ({ key: registryKey(seed, i), secret: newTripSecret() }));
    const beyondGap = { key: registryKey(seed, 10), secret: newTripSecret() };
    const relay = [...trips, beyondGap].map((t) => selfShare(t.key, t.secret));
    const asked: string[] = [];
    const found = await recoverTrips(seed, (pk) => {
      asked.push(pk);
      return relay.filter((e) => e.pubkey === pk);
    });
    expect(found.map((f) => f.key.index)).toEqual([0, 1, 4]);
    expect(found.map((f) => f.trips)).toEqual(
      trips.map((t) => [{ tripTag: tripTagOf(t.secret), tripSecret: t.secret }]),
    );
    // 0-4 in use or within the gap, then 5 empty in a row (5..9): index 10 is never asked
    expect(asked).toHaveLength(10);
  });

  it('ignores forged signatures and events of other keys; one secret per trip', () => {
    const me = registryKey(seed, 0);
    const secret = newTripSecret();
    const good = selfShare(me, secret);
    const forged = { ...good, sig: '00'.repeat(64) };
    const notMine = selfShare(registryKey(seed, 1), secret);
    expect(tripSecretsOf(me, [forged, notMine])).toEqual([]);
    expect(tripSecretsOf(me, [good, selfShare(me, secret, 1_760_000_001)])).toEqual([
      { tripTag: tripTagOf(secret), tripSecret: secret },
    ]);
  });
});

describe('kitty-bind:v2', () => {
  const tripTag = 'e'.repeat(64);
  const pk = registryKey(seed, 0).pubkey;
  const node = `02${'a1'.repeat(32)}`;
  const decoded = { payeePubkey: node, description: bindDescriptionV2(tripTag, pk) };

  it('ties the node to the registry key in this trip', () => {
    expect(decoded.description).toBe(`kitty-bind:v2:${tripTag}:${pk}`);
    expect(
      bindInvoiceRefusal(decoded, { tripTag, registryPubkey: pk, nodePubkey: node }),
    ).toBeNull();
  });

  it('refuses another trip tag, another key or another node', () => {
    const p = { tripTag, registryPubkey: pk, nodePubkey: node };
    expect(bindInvoiceRefusal(decoded, { ...p, tripTag: 'f'.repeat(64) })).toMatch(/trip and key/);
    expect(
      bindInvoiceRefusal(decoded, { ...p, registryPubkey: registryKey(seed, 1).pubkey }),
    ).toMatch(/trip and key/);
    expect(bindInvoiceRefusal(decoded, { ...p, nodePubkey: `02${'b2'.repeat(32)}` })).toMatch(
      /another node/,
    );
  });
});
