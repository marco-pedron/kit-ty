import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSign, fakeVerify, signatureVerifier } from './crypto.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Fixed secrets: deterministic keys and signatures, no randomness in tests.
const aliceSecret = new Uint8Array(32).fill(1);
const bobSecret = new Uint8Array(32).fill(2);
const alicePub = bytesToHex(ed25519.getPublicKey(aliceSecret));
const bobPub = bytesToHex(ed25519.getPublicKey(bobSecret));

function sign(secret: Uint8Array, message: string): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(message), secret));
}

const verify = (pub: unknown, msg: unknown, sig: unknown): boolean =>
  signatureVerifier.verify(pub as string, msg as string, sig as string);

const message = '{"body":{},"tripId":"vietnam-2026","type":"LINE_SEEN","v":1}';

describe('signatureVerifier (ed25519, SPEC §9.1)', () => {
  it('accepts RFC 8032 test vector 1', () => {
    const pub = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const sig =
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(verify(pub, '', sig)).toBe(true);
  });

  it('accepts a signature by the author over the message', () => {
    expect(verify(alicePub, message, sign(aliceSecret, message))).toBe(true);
    expect(verify(alicePub, 'ciao ☕ €', sign(aliceSecret, 'ciao ☕ €'))).toBe(true);
  });

  it('rejects an altered message', () => {
    expect(verify(alicePub, `${message} `, sign(aliceSecret, message))).toBe(false);
  });

  it('rejects an altered signature', () => {
    const bytes = hexToBytes(sign(aliceSecret, message));
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    expect(verify(alicePub, message, bytesToHex(bytes))).toBe(false);
  });

  it("rejects another key's signature", () => {
    expect(verify(alicePub, message, sign(bobSecret, message))).toBe(false);
    expect(verify(bobPub, message, sign(aliceSecret, message))).toBe(false);
  });

  it('rejects a non-canonical s (s + L), which lax verifiers would accept', () => {
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const bytes = hexToBytes(sign(aliceSecret, message));
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(bytes[32 + i] ?? 0);
    let t = s + L;
    for (let i = 0; i < 32; i++) {
      bytes[32 + i] = Number(t & 0xffn);
      t >>= 8n;
    }
    expect(verify(alicePub, message, bytesToHex(bytes))).toBe(false);
  });

  it('returns false, never throws, on malformed input', () => {
    const sig = sign(aliceSecret, message);
    const cases: [unknown, unknown, unknown][] = [
      ['', message, sig],
      [alicePub, message, ''],
      [alicePub.toUpperCase(), message, sig],
      [alicePub, message, sig.toUpperCase()],
      [alicePub.slice(2), message, sig],
      [`${alicePub}00`, message, sig],
      [alicePub, message, sig.slice(2)],
      [alicePub, message, `${sig}00`],
      [`zz${alicePub.slice(2)}`, message, sig],
      [alicePub, message, `zz${sig.slice(2)}`],
      [`02${alicePub}`, message, sig], // a node pubkey is never an author with rln-rest
      ['ff'.repeat(32), message, sig], // y >= p: not a canonical point encoding
      [undefined, message, sig],
      [alicePub, null, sig],
      [alicePub, message, 42],
      [{}, [], hexToBytes(sig)],
    ];
    for (const [pub, msg, s] of cases) {
      expect(() => verify(pub, msg, s)).not.toThrow();
      expect(verify(pub, msg, s)).toBe(false);
    }
  });
});

describe('dev fakes', () => {
  it('fakes refuse to run without KITTY_FAKES=1', () => {
    vi.stubEnv('KITTY_FAKES', '');
    expect(() => fakeSign('a', 'm')).toThrow(/KITTY_FAKES=1/);
    expect(() => fakeVerify('a', 'm', 's')).toThrow(/KITTY_FAKES=1/);
  });

  it('fake signatures verify only for the same key and message', () => {
    vi.stubEnv('KITTY_FAKES', '1');
    const sig = fakeSign('alice', 'hello');
    expect(fakeVerify('alice', 'hello', sig)).toBe(true);
    expect(fakeVerify('bob', 'hello', sig)).toBe(false);
    expect(fakeVerify('alice', 'hello!', sig)).toBe(false);
  });
});
