import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { assetIdToBytes } from '../bolt11.js';

// Test-only BOLT11 encoder, written apart from the decoder so the tests do not check the
// decoder against itself. Produces what RLN produces: d, n, p, s, x and, for RGB, tags 30/31.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    GEN.forEach((g, i) => {
      if ((top >>> i) & 1) chk ^= g;
    });
  }
  return chk;
}

function bech32(hrp: string, words: number[]): string {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const pre = [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
  const mod = polymod([...pre, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

function bytesToWords(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function bigintToWords(n: bigint, minLen = 1): number[] {
  const out: number[] = [];
  for (let v = n; v > 0n; v /= 32n) out.unshift(Number(v % 32n));
  while (out.length < minLen) out.unshift(0);
  return out;
}

function wordsToSigningBytes(words: number[]): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return out;
}

const tag = (type: number, words: number[]) => [
  type,
  words.length >>> 5,
  words.length & 31,
  ...words,
];

export interface InvoiceSpec {
  /** secp256k1 secret key of the node that signs. */
  nodeSecret: Uint8Array;
  /** Default 'lnbcrt30u' (3000 sat, the rgb_htlc_min_msat of SPEC §10.1). */
  hrp?: string;
  timestampSec: number;
  paymentHash: Uint8Array;
  description: string;
  expirySec?: number;
  assetId?: string | undefined;
  assetAmount?: bigint | undefined;
  /** The `n` field; default the signer's pubkey, null to leave it out. */
  payee?: Uint8Array | null;
  /** Raw extra fields, appended after the others. */
  extra?: [type: number, words: number[]][];
}

export function encodeBolt11(spec: InvoiceSpec): string {
  const hrp = spec.hrp ?? 'lnbcrt30u';
  const payee = spec.payee === undefined ? secp256k1.getPublicKey(spec.nodeSecret) : spec.payee;
  const data = [
    ...bigintToWords(BigInt(spec.timestampSec), 7),
    ...tag(13, bytesToWords(utf8ToBytes(spec.description))),
    ...(payee === null ? [] : tag(19, bytesToWords(payee))),
    ...tag(1, bytesToWords(spec.paymentHash)),
    ...tag(16, bytesToWords(new Uint8Array(32).fill(0x5e))),
    ...tag(6, bigintToWords(BigInt(spec.expirySec ?? 3600))),
    ...(spec.assetAmount === undefined ? [] : tag(30, bigintToWords(spec.assetAmount))),
    ...(spec.assetId === undefined ? [] : tag(31, bytesToWords(assetIdToBytes(spec.assetId)))),
    ...(spec.extra ?? []).flatMap(([t, w]) => tag(t, w)),
  ];
  const msg = sha256(Uint8Array.from([...utf8ToBytes(hrp), ...wordsToSigningBytes(data)]));
  // noble 'recovered' is recid || r || s; BOLT11 wants r || s || recid.
  const rec = secp256k1.sign(msg, spec.nodeSecret, { prehash: false, format: 'recovered' });
  const sig = Uint8Array.from([...rec.slice(1), rec[0]!]);
  return bech32(hrp, [...data, ...bytesToWords(sig)]);
}

/** Flips one data character (not the hrp), keeping the string valid bech32 characters. */
export function tamper(bolt11: string, at = 20): string {
  const sep = bolt11.lastIndexOf('1');
  const i = sep + at;
  const c = bolt11[i]!;
  const next = CHARSET[(CHARSET.indexOf(c) + 1) % 32]!;
  return bolt11.slice(0, i) + next + bolt11.slice(i + 1);
}
