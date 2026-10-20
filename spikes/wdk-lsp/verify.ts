// H (copied from spikes/wdk/verify.ts): verify a WDK node signature (account.sign) in pure TypeScript, no native library.
// Format (LDK lightning::util::message_signing, same as LND): zbase32 of 65 bytes
// [31 + recid, r(32), s(32)], recoverable ECDSA over sha256d("Lightning Signed Message:" + msg).
// Verification = recover the pubkey and compare with the expected node pubkey.
// Usage: node verify.ts [<message> <signature> <pubkey-hex>]   (no args: self-test from data/state.json)

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

export function zbase32Decode (s: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const v = ZBASE32.indexOf(ch)
    if (v < 0) throw new Error(`not zbase32: ${ch}`)
    value = ((value << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

export function lightningMessageHash (message: string): Uint8Array {
  return sha256(sha256(utf8ToBytes('Lightning Signed Message:' + message)))
}

export function recoverSigner (message: string, signature: string): string {
  const raw = zbase32Decode(signature)
  if (raw.length !== 65) throw new Error(`expected 65 bytes, got ${raw.length}`)
  const header = raw[0]
  if (header < 31 || header > 34) throw new Error(`unexpected header byte ${header}`)
  const sig = secp256k1.Signature.fromCompact(raw.subarray(1)).addRecoveryBit(header - 31)
  return sig.recoverPublicKey(lightningMessageHash(message)).toHex(true)
}

export function verifyNodeSignature (message: string, signature: string, pubkeyHex: string): boolean {
  try {
    return recoverSigner(message, signature) === pubkeyHex.toLowerCase()
  } catch {
    return false
  }
}

