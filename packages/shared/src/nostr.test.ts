import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getEventHash, serializeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import type { SignatureVerifier } from './crypto.js';
import {
  hasValidId,
  KIND_REGISTRY,
  MAX_PARENTS,
  nostrEventId,
  NostrFormatError,
  parseRegistryTags,
  registryTags,
  serializeForId,
  verifyNostrEvent,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr.js';

// A stand-in for crypto.ts's Schnorr verifier (stream B, separate PR): message = id hex.
const verifier: SignatureVerifier = {
  verify: (pubkey, message, sig) => {
    try {
      return schnorr.verify(hexToBytes(sig), hexToBytes(message), hexToBytes(pubkey));
    } catch {
      return false;
    }
  },
};

const G = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function unsigned(content: string, tags: string[][] = []): UnsignedNostrEvent {
  return { pubkey: G, created_at: 1_760_000_000, kind: KIND_REGISTRY, tags, content };
}

describe('NIP-01 id', () => {
  // Expected ids computed independently with Python:
  // sha256(json.dumps([0, pubkey, created_at, kind, tags, content], separators=(',', ':'),
  //        ensure_ascii=False).encode()).
  it('matches an independent implementation on plain content', () => {
    expect(nostrEventId(unsigned('hello'))).toBe(
      '3ec632eb405b76ebf6f52401bee0cfa4ac664e6c5152f576c0aefe500ce6537b',
    );
  });

  it('escapes exactly the seven NIP-01 characters and keeps UTF-8 verbatim', () => {
    const e = unsigned('line\nbreak "quoted" back\\slash\ttab\rcr\bbs\ffeed — ünïcödé 🍜 ', [
      ['T', A],
      ['e', B],
    ]);
    expect(serializeForId(e)).toContain('\\n');
    expect(serializeForId(e)).toContain('ünïcödé 🍜');
    expect(nostrEventId(e)).toBe(
      'e484f7138f917d887d7aa3320745ec46d881d42f415059f841cb71554c136af2',
    );
  });

  it.each([
    'hello',
    '',
    '{"v":2,"tripId":"vietnam-2026"}',
    'emoji 🍜🍺 and CJK 越南',
    'quotes " and \\ backslashes \\" mixed',
    '\n\r\t\b\f',
    'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4Dw',
  ])('agrees with nostr-tools on %j', (content) => {
    const e = unsigned(content, [
      ['T', A],
      ['e', B],
      ['e', C],
    ]);
    expect(serializeForId(e)).toBe(serializeEvent(e));
    expect(nostrEventId(e)).toBe(getEventHash(e));
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['U+0001', '\u0001'],
    ['vertical tab', '\u000b'],
    ['U+001F', '\u001f'],
    ['lone high surrogate', 'x\ud83cy'],
    ['lone low surrogate', '\udf5c'],
  ])('refuses %s, where NIP-01 and JSON.stringify disagree', (_name, content) => {
    expect(() => nostrEventId(unsigned(content))).toThrow(NostrFormatError);
    expect(() => nostrEventId(unsigned('ok', [['T', content]]))).toThrow(NostrFormatError);
  });

  it('refuses malformed fields', () => {
    expect(() => nostrEventId({ ...unsigned('x'), pubkey: G.toUpperCase() })).toThrow();
    expect(() => nostrEventId({ ...unsigned('x'), kind: 70_000 })).toThrow();
    expect(() => nostrEventId({ ...unsigned('x'), created_at: 1.5 })).toThrow();
    expect(() => nostrEventId({ ...unsigned('x'), tags: [[]] })).toThrow();
  });
});

describe('signed events', () => {
  const sk = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
  const signed = finalizeEvent(
    { kind: KIND_REGISTRY, created_at: 1_760_000_000, tags: [['T', A]], content: 'x' },
    sk,
  ) as NostrEvent;

  it('accepts an event signed by nostr-tools', () => {
    expect(signed.pubkey).toBe(bytesToHex(schnorr.getPublicKey(sk)));
    expect(hasValidId(signed)).toBe(true);
    expect(verifyNostrEvent(signed, verifier)).toBe(true);
  });

  it('refuses a changed field, even with the original signature', () => {
    expect(verifyNostrEvent({ ...signed, content: 'y' }, verifier)).toBe(false);
    expect(verifyNostrEvent({ ...signed, created_at: signed.created_at + 1 }, verifier)).toBe(
      false,
    );
    expect(verifyNostrEvent({ ...signed, tags: [['T', B]] }, verifier)).toBe(false);
  });

  it('refuses a recomputed id with someone else’s signature', () => {
    const other = { ...signed, content: 'y' };
    const forged = { ...other, id: nostrEventId(other) };
    expect(hasValidId(forged)).toBe(true);
    expect(verifyNostrEvent(forged, verifier)).toBe(false);
  });

  it('never throws on garbage', () => {
    expect(hasValidId({ ...signed, tags: [['T', '\u0000']] })).toBe(false);
  });
});

describe('registry tags', () => {
  it('writes T first, then sorted unique parents', () => {
    expect(registryTags(A, [C, B, C])).toEqual([
      ['T', A],
      ['e', B],
      ['e', C],
    ]);
  });

  it('reads them back', () => {
    expect(
      parseRegistryTags([
        ['e', C],
        ['T', A],
        ['e', B],
      ]),
    ).toEqual({
      tripTag: A,
      parents: [B, C],
    });
  });

  it.each([
    ['no T tag', [['e', B]]],
    [
      'two T tags',
      [
        ['T', A],
        ['T', B],
      ],
    ],
    [
      'duplicate parent',
      [
        ['T', A],
        ['e', B],
        ['e', B],
      ],
    ],
    [
      'extra tag',
      [
        ['T', A],
        ['p', B],
      ],
    ],
    [
      'relay hint on e',
      [
        ['T', A],
        ['e', B, 'wss://relay'],
      ],
    ],
    [
      'non-hex parent',
      [
        ['T', A],
        ['e', 'xyz'],
      ],
    ],
    [
      'uppercase parent',
      [
        ['T', A],
        ['e', B.toUpperCase()],
      ],
    ],
    ['NIP-70 protected', [['T', A], ['-']]],
  ])('refuses %s', (_name, tags) => {
    expect(() => parseRegistryTags(tags)).toThrow(NostrFormatError);
  });

  it(`allows at most ${MAX_PARENTS} parents`, () => {
    const ids = Array.from({ length: MAX_PARENTS + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    expect(() => registryTags(A, ids.slice(0, MAX_PARENTS))).not.toThrow();
    expect(() => registryTags(A, ids)).toThrow(NostrFormatError);
  });
});
