import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DecodedInvoiceSchema, type DecodedInvoice } from '@kitty/shared';

// BOLT11 decoder for the relay's validateEvent (ValidationDeps.decodeInvoice, SPEC §9.3).
// RGB invoices of rgb-lightning-node carry two extra tagged fields, checked against the
// node's own /decodelninvoice on a real invoice (spikes/wdk/calls.log:78-79):
//   tag 30 = asset_amount (integer, DUSD cents), tag 31 = asset_id (32-byte contract id,
//   shown as `rgb:` + baid64, the alphabet and chunking of the baid64 crate 0.4.1 used by
//   RLN d4762ac).
// The signature is always verified: the payee check (SPEC §13 #1) is worthless otherwise,
// since anyone can write any pubkey in the `n` field. Regtest only (CLAUDE.md rule 9).
// Any problem throws; validateEvent turns it into "invoice not decodable".

export class Bolt11Error extends Error {
  override readonly name = 'Bolt11Error';
}

const fail = (msg: string): never => {
  throw new Bolt11Error(msg);
};

// ---------- bech32 (BIP 173, without the 90-character limit, as BOLT11 requires) ----------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

function bech32Decode(str: string): { hrp: string; words: number[] } {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) fail('mixed-case invoice');
  const s = str.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) fail('no bech32 separator');
  const hrp = s.slice(0, sep);
  const words = [...s.slice(sep + 1)].map((c) => {
    const w = CHARSET.indexOf(c);
    if (w < 0) fail(`invalid bech32 character '${c}'`);
    return w;
  });
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) fail('bad bech32 checksum');
  return { hrp, words: words.slice(0, -6) };
}

/** 5-bit words → bytes. `pad`: keep the trailing partial byte (BOLT11 signing data). */
function wordsToBytes(words: readonly number[], pad: boolean): Uint8Array {
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
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

const wordsToBigint = (words: readonly number[]) =>
  words.reduce((acc, w) => acc * 32n + BigInt(w), 0n);

// ---------- baid64 (contract ids, RGB v0.11.1) ----------

/** BAID64_ALPHABET of the baid64 crate (0.4.1 and 0.4.2 are identical): `_` = 62, `~` = 63. */
const BAID64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_~';

/** 32 bytes → `rgb:` + baid64 without padding, chunked 8 then 7 by '-' (like RLN prints it). */
export function assetIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) fail('an asset id is 32 bytes');
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let s = '';
  for (let i = 0; i < bits.length; i += 6)
    s += BAID64[parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)];
  const chunks = [s.slice(0, 8)];
  for (let i = 8; i < s.length; i += 7) chunks.push(s.slice(i, i + 7));
  return `rgb:${chunks.join('-')}`;
}

/** The inverse of assetIdFromBytes. */
export function assetIdToBytes(assetId: string): Uint8Array {
  if (!assetId.startsWith('rgb:')) fail('an asset id starts with rgb:');
  const s = assetId.slice(4).replaceAll('-', '');
  if (s.length !== 43) fail('an asset id has 43 baid64 characters');
  let bits = '';
  for (const c of s) {
    const v = BAID64.indexOf(c);
    if (v < 0) fail(`invalid baid64 character '${c}'`);
    bits += v.toString(2).padStart(6, '0');
  }
  if (!/^0*$/.test(bits.slice(256))) fail('non-canonical asset id');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

// ---------- BOLT11 ----------

const MSAT_PER_BTC = 100_000_000_000n;
const DIVISOR: Record<string, bigint> = { m: 1_000n, u: 1_000_000n, n: 1_000_000_000n };

/** `lnbcrt[amount[multiplier]]` → amount in msat, or null if the invoice has no amount. */
function regtestAmountMsat(hrp: string): bigint | null {
  const m = /^lnbcrt(?:(\d+)([munp])?)?$/.exec(hrp);
  if (m === null) return fail(`not a regtest invoice (${hrp.slice(0, 6)}…): regtest only`);
  const [, digits, unit] = m;
  if (digits === undefined) return null;
  if (digits.length > 1 && digits.startsWith('0')) fail('amount with leading zeros');
  const n = BigInt(digits);
  if (unit === undefined) return n * MSAT_PER_BTC;
  if (unit === 'p') {
    // 1 pico-BTC = 0.1 msat: only whole msat are valid.
    if (n % 10n !== 0n) fail('amount is not a whole number of msat');
    return n / 10n;
  }
  return (n * MSAT_PER_BTC) / DIVISOR[unit]!;
}

const TAG = { p: 1, d: 13, n: 19, x: 6, s: 16, assetAmount: 30, assetId: 31 } as const;
/** Fields whose length is fixed: BOLT11 says a reader skips them if the length is wrong. */
const FIXED_WORDS: Partial<Record<number, number>> = { [TAG.p]: 52, [TAG.s]: 52, [TAG.n]: 53 };
const DEFAULT_EXPIRY_SEC = 3600n;
const SIGNATURE_WORDS = 104;

export function decodeBolt11(bolt11: string): DecodedInvoice {
  const { hrp, words } = bech32Decode(bolt11.trim());
  const amtMsat = regtestAmountMsat(hrp);
  if (words.length < 7 + SIGNATURE_WORDS) fail('invoice too short');

  const data = words.slice(0, -SIGNATURE_WORDS);
  const timestamp = wordsToBigint(data.slice(0, 7));
  const tags = new Map<number, number[]>();
  for (let i = 7; i < data.length;) {
    if (i + 3 > data.length) fail('truncated tagged field');
    const type = data[i]!;
    const len = data[i + 1]! * 32 + data[i + 2]!;
    const value = data.slice(i + 3, i + 3 + len);
    if (value.length !== len) fail('truncated tagged field');
    i += 3 + len;
    const fixed = FIXED_WORDS[type];
    if (fixed !== undefined && len !== fixed) continue;
    // RLN never repeats a field; a repeated one could make us and the node read different
    // values from the same invoice, so it is refused.
    if (tags.has(type)) fail(`repeated tagged field ${type}`);
    tags.set(type, value);
  }

  const p = tags.get(TAG.p) ?? fail('no payment hash');
  const paymentHash = bytesToHex(wordsToBytes(p, false));
  const d = tags.get(TAG.d);
  const description = d === undefined ? '' : utf8(wordsToBytes(d, false));
  const x = tags.get(TAG.x);
  const expiry = x === undefined ? DEFAULT_EXPIRY_SEC : wordsToBigint(x);
  const amount = tags.get(TAG.assetAmount);
  const id = tags.get(TAG.assetId);
  if ((amount === undefined) !== (id === undefined)) fail('asset id and asset amount go together');
  if (id !== undefined && id.length !== 52) fail('asset id is not 32 bytes');

  // Signature: r || s || recovery id over sha256(hrp bytes || data words as bytes).
  const sigBytes = wordsToBytes(words.slice(-SIGNATURE_WORDS), false);
  const recid = sigBytes[64]!;
  if (sigBytes.length !== 65 || recid > 3) fail('malformed signature');
  const msg = sha256(
    Uint8Array.from([...new TextEncoder().encode(hrp), ...wordsToBytes(data, true)]),
  );
  const compact = sigBytes.slice(0, 64);
  const n = tags.get(TAG.n);
  let payee: Uint8Array;
  if (n !== undefined) {
    payee = wordsToBytes(n, false);
    if (!safe(() => secp256k1.verify(compact, msg, payee, { prehash: false }))) {
      fail('signature does not match the payee');
    }
  } else {
    const recovered = Uint8Array.from([recid, ...compact]); // noble's 'recovered' order
    payee =
      safe(() => secp256k1.recoverPublicKey(recovered, msg, { prehash: false })) ??
      fail('bad signature');
  }

  return DecodedInvoiceSchema.parse({
    bolt11: bolt11.trim(),
    payeePubkey: bytesToHex(payee),
    paymentHash,
    assetId: id === undefined ? null : assetIdFromBytes(wordsToBytes(id, false)),
    cents: amount === undefined ? null : wordsToBigint(amount).toString(),
    amtMsat: amtMsat === null ? null : amtMsat.toString(),
    description,
    expiresAt: new Date(Number((timestamp + expiry) * 1000n)).toISOString(),
  });
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('description is not UTF-8');
  }
}

/** noble throws on malformed points or signatures; for us that is just "not valid". */
function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
