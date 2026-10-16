import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotImplementedError, fakeSign, fakeVerify, signatureVerifier } from './crypto.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('crypto stub and dev fakes', () => {
  it('the real verifier is task B4', () => {
    expect(() => signatureVerifier.verify('a', 'b', 'c')).toThrow(NotImplementedError);
  });

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
