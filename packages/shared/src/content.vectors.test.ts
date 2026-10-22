import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './canonical.js';
import {
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  Nip44Error,
  nip44PaddedLength,
} from './content.js';

// Official NIP-44 vectors, downloaded at every run (not kept in the repo): the file
// https://github.com/paulmillr/nip44/blob/main/nip44.vectors.json, accepted only if its sha256
// is the one published in NIP-44 itself (44.md, "Tests and code"). Without network the suite
// is skipped with a warning; an HTTP error or a wrong checksum still fails.
const NIP44_SPEC_URL = 'https://raw.githubusercontent.com/nostr-protocol/nips/master/44.md';
const NIP44_VECTORS_URL =
  'https://raw.githubusercontent.com/paulmillr/nip44/main/nip44.vectors.json';

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

class OfflineError extends Error {}

async function download(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new OfflineError(`cannot download ${url}`, { cause: e });
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadVectors(): Promise<{ raw: string; published: string } | null> {
  let spec: string, raw: string;
  try {
    [spec, raw] = await Promise.all([download(NIP44_SPEC_URL), download(NIP44_VECTORS_URL)]);
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    process.stderr.write(`\nWARNING: NIP-44 vector tests skipped, no network (${e.message})\n`);
    return null;
  }
  const published = /\b([0-9a-f]{64})\s+nip44\.vectors\.json\b/.exec(spec)?.[1];
  if (published === undefined) throw new Error(`no vectors checksum found in ${NIP44_SPEC_URL}`);
  // Nothing below runs on vectors NIP-44 does not vouch for.
  if (sha256Hex(raw) !== published)
    throw new Error(`${NIP44_VECTORS_URL} does not match the sha256 published in NIP-44`);
  return { raw, published };
}

const loaded = await loadVectors();

describe('NIP-44 v2 on the official vectors (needs network)', () => {
  if (loaded === null) {
    it.skip('no network: vectors not downloaded, suite skipped', () => {});
    return;
  }
  const { valid, invalid } = (JSON.parse(loaded.raw) as Vectors).v2;

  it('uses the file whose sha256 NIP-44 publishes', () => {
    expect(sha256Hex(loaded.raw)).toBe(loaded.published);
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
});
