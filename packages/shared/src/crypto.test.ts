import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './canonical.js';
import {
  checkBindInvoice,
  ed25519PublicKeyHex,
  ed25519Sign,
  fakeSign,
  fakeVerify,
  schnorrPublicKeyHex,
  schnorrSign,
  schnorrVerifier,
  signatureVerifier,
} from './crypto.js';
import type { DecodedInvoice } from './domain.js';

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

describe('ed25519Sign and ed25519PublicKeyHex (Wallet.sign, B3)', () => {
  const rfcSecret = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';

  it('reproduces RFC 8032 test vector 1', () => {
    expect(ed25519PublicKeyHex(rfcSecret)).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    expect(ed25519Sign(rfcSecret, '')).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('produces signatures the verifier accepts, bound to the message', () => {
    const sig = ed25519Sign(rfcSecret, message);
    expect(verify(ed25519PublicKeyHex(rfcSecret), message, sig)).toBe(true);
    expect(verify(ed25519PublicKeyHex(rfcSecret), `${message} `, sig)).toBe(false);
  });

  it('rejects a malformed secret', () => {
    expect(() => ed25519Sign('ab', message)).toThrow();
    expect(() => ed25519PublicKeyHex(rfcSecret.toUpperCase())).toThrow();
  });
});

describe('checkBindInvoice (SPEC §9.1)', () => {
  const aliceNode = `02${'a1'.repeat(32)}`;
  const otherNode = `03${'b2'.repeat(32)}`;
  const invoice = (description: string, payeePubkey = aliceNode): DecodedInvoice => ({
    bolt11: 'lnbcrt1bind',
    payeePubkey,
    paymentHash: '00'.repeat(32),
    assetId: null,
    cents: null,
    amtMsat: null,
    description,
    expiresAt: '2026-10-18T12:00:00.000Z',
  });
  const good = `kitty-bind:${sha256Hex(alicePub)}`;

  it('accepts an invoice from the member node committing to the app key', () => {
    expect(checkBindInvoice(invoice(good), alicePub, aliceNode)).toBe(true);
  });

  it('rejects an invoice from another node', () => {
    expect(checkBindInvoice(invoice(good, otherNode), alicePub, aliceNode)).toBe(false);
    expect(checkBindInvoice(invoice(good), alicePub, otherNode)).toBe(false);
  });

  it('rejects a description for another app key', () => {
    expect(checkBindInvoice(invoice(`kitty-bind:${sha256Hex(bobPub)}`), alicePub, aliceNode)).toBe(
      false,
    );
  });

  it('rejects descriptions that are close but not exact', () => {
    for (const d of [
      `kitty-bind:${alicePub}`,
      `kitty-bind:${sha256Hex(alicePub).toUpperCase()}`,
      `${good} `,
      ` ${good}`,
      `KITTY-BIND:${sha256Hex(alicePub)}`,
      sha256Hex(alicePub),
      '',
    ])
      expect(checkBindInvoice(invoice(d), alicePub, aliceNode)).toBe(false);
  });

  it('rejects a malformed app key, even with a matching description', () => {
    for (const key of [alicePub.toUpperCase(), alicePub.slice(2), `${alicePub}00`, ''])
      expect(checkBindInvoice(invoice(`kitty-bind:${sha256Hex(key)}`), key, aliceNode)).toBe(false);
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

// BIP-340 official vectors: https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv
// (BSD-2-Clause). Columns: index, secret key, public key, aux_rand, message, signature,
// verification result, comment.
const bip340 = readFileSync(new URL('./test/vectors/bip340.csv', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [index, secret, pub, aux, msg, sig, ok, comment] = line.split(',');
    return {
      index: Number(index),
      secret: (secret ?? '').toLowerCase(),
      pub: (pub ?? '').toLowerCase(),
      aux: (aux ?? '').toLowerCase(),
      msg: (msg ?? '').toLowerCase(),
      sig: (sig ?? '').toLowerCase(),
      ok: ok === 'TRUE',
      comment: comment ?? '',
    };
  });
const digestVectors = bip340.filter((v) => v.msg.length === 64);

describe('schnorrVerifier (BIP-340, registry v2)', () => {
  it.each(digestVectors)('vector $index: $ok $comment', (v) => {
    expect(schnorrVerifier.verify(v.pub, v.msg, v.sig)).toBe(v.ok);
  });

  it.each(digestVectors.filter((v) => v.secret !== ''))(
    'vector $index: key and signature from the secret',
    (v) => {
      expect(schnorrPublicKeyHex(v.secret)).toBe(v.pub);
      // The vectors fix aux_rand; schnorrSign draws it, so check the result verifies instead.
      expect(
        bytesToHex(schnorr.sign(hexToBytes(v.msg), hexToBytes(v.secret), hexToBytes(v.aux))),
      ).toBe(v.sig);
      expect(schnorrVerifier.verify(v.pub, v.msg, schnorrSign(v.secret, v.msg))).toBe(true);
    },
  );

  it('refuses messages that are not 32-byte digests (vectors 15-18 sign other lengths)', () => {
    const others = bip340.filter((v) => v.msg.length !== 64);
    expect(others.map((v) => v.index)).toEqual([15, 16, 17, 18]);
    for (const v of others) expect(schnorrVerifier.verify(v.pub, v.msg, v.sig)).toBe(false);
  });

  const secret = '03'.padStart(64, '0');
  const pub = schnorrPublicKeyHex(secret);
  const digest = sha256Hex('kitty registry event');

  it('refuses another key, a changed digest, a changed signature', () => {
    const sig = schnorrSign(secret, digest);
    expect(schnorrVerifier.verify(pub, digest, sig)).toBe(true);
    expect(schnorrVerifier.verify(schnorrPublicKeyHex('04'.padStart(64, '0')), digest, sig)).toBe(
      false,
    );
    expect(schnorrVerifier.verify(pub, sha256Hex('another event'), sig)).toBe(false);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(schnorrVerifier.verify(pub, digest, flipped)).toBe(false);
  });

  it('never throws on malformed input', () => {
    const sig = schnorrSign(secret, digest);
    expect(schnorrVerifier.verify(pub.toUpperCase(), digest, sig)).toBe(false);
    expect(schnorrVerifier.verify(`02${pub}`, digest, sig)).toBe(false);
    expect(schnorrVerifier.verify(pub, digest, sig.slice(2))).toBe(false);
    expect(verifyAny(schnorrVerifier, null, digest, sig)).toBe(false);
    expect(verifyAny(schnorrVerifier, pub, 42, sig)).toBe(false);
  });

  it('is not the ed25519 verifier: a signature of one never passes the other', () => {
    const sig = schnorrSign(secret, digest);
    expect(signatureVerifier.verify(pub, digest, sig)).toBe(false);
  });
});

function verifyAny(v: typeof schnorrVerifier, pub: unknown, msg: unknown, sig: unknown): boolean {
  return v.verify(pub as string, msg as string, sig as string);
}
