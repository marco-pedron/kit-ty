import { LedgerError } from './errors.js';

const DIGITS = '0123456789abcdef';

/** Lowercase hex → bytes, e.g. a Lightning preimage before hashing it. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new LedgerError('INVALID_EVENT', 'odd-length hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = DIGITS.indexOf(hex[2 * i] ?? '');
    const lo = DIGITS.indexOf(hex[2 * i + 1] ?? '');
    if (hi < 0 || lo < 0) throw new LedgerError('INVALID_EVENT', 'not lowercase hex');
    bytes[i] = hi * 16 + lo;
  }
  return bytes;
}
