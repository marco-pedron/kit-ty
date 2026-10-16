import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalHash, canonicalize, sha256Hex } from './canonical.js';

describe('canonicalize', () => {
  it('sorts keys by UTF-16 code units, recursively, without whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [1, 2], c: null }, A: true })).toBe(
      '{"A":true,"a":{"c":null,"d":[1,2]},"b":1}',
    );
    // "é" (U+00E9) sorts after "z" (U+007A); "😀" (surrogates D83D…) after "é".
    expect(canonicalize({ '😀': 1, é: 2, z: 3 })).toBe('{"z":3,"é":2,"😀":1}');
  });

  it('writes bigint as the same decimal string as the money codec', () => {
    expect(canonicalize({ cents: 309n })).toBe('{"cents":"309"}');
    expect(canonicalize({ cents: 309n })).toBe(canonicalize({ cents: '309' }));
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalize('a"b\\c\n\u0001')).toBe(JSON.stringify('a"b\\c\n\u0001'));
  });

  it('skips undefined properties', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it.each([
    ['a float', { x: 0.5 }],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an unsafe integer', 2 ** 53],
    ['undefined in an array', [1, undefined]],
    ['a Date', new Date(0)],
    ['a function', () => 1],
    ['a Map', new Map()],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalJsonError);
  });

  it('normalises -0 to 0', () => {
    expect(canonicalize(-0)).toBe('0');
  });
});

describe('sha256Hex', () => {
  it('matches the known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
  });

  it('canonicalHash does not depend on key order', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });
});
