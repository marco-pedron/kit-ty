import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Canonical JSON (RFC 8785 / JCS) for what gets signed and hashed (SPEC §9.1).
// Our payloads have no floats, so the number rules of JCS reduce to safe integers:
// - object keys sorted by UTF-16 code units, no whitespace;
// - strings escaped as JSON.stringify does (JCS is defined on it);
// - bigint → decimal string, the same string the money codec puts on the wire,
//   so canonicalize(decoded) === canonicalize(encoded);
// - non-integer or unsafe numbers, NaN, Infinity, undefined in arrays, functions, symbols,
//   Dates and other class instances are rejected. Object properties set to undefined are
//   skipped, like absent optional fields.

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

export function canonicalize(value: unknown): string {
  return write(value, '$');
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isSafeInteger(value))
        throw new CanonicalJsonError(`${path}: only safe integers allowed, got ${value}`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not JSON`);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v, i) => {
        if (v === undefined) throw new CanonicalJsonError(`${path}[${i}]: undefined in array`);
        return write(v, `${path}[${i}]`);
      })
      .join(',')}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new CanonicalJsonError(`${path}: only plain objects allowed`);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, `${path}.${k}`)}`).join(',')}}`;
}

/** sha256 as lowercase hex; strings are hashed as UTF-8. */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

/** sha256Hex(canonicalize(value)). */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
