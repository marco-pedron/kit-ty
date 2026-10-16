// Q8: verify a WDK node signature (account.sign) in pure TypeScript, no native library.
// Format (LDK lightning::util::message_signing, same as LND): zbase32 of 65 bytes
// [31 + recid, r(32), s(32)], recoverable ECDSA over sha256d("Lightning Signed Message:" + msg).
// Verification = recover the pubkey and compare with the expected node pubkey.
// Usage: node verify.ts [<message> <signature> <pubkey-hex>]   (no args: self-test from data/state.json)
import { readFileSync } from 'node:fs'
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

const [, , message, signature, pubkey] = process.argv
if (message !== undefined && signature && pubkey) {
  console.log(JSON.stringify({ signer: recoverSigner(message, signature), valid: verifyNodeSignature(message, signature, pubkey) }))
} else {
  const { sig, pubkeys } = JSON.parse(readFileSync(new URL('./data/state.json', import.meta.url), 'utf8'))
  const flip = (s: string) => s.slice(0, 20) + (s[20] === 'y' ? 'b' : 'y') + s.slice(21)
  const results = {
    valid_m1: verifyNodeSignature(sig.m1, sig.s1, sig.pubkey),
    valid_m2: verifyNodeSignature(sig.m2, sig.s2, sig.pubkey),
    different_sigs: sig.s1 !== sig.s2,
    wrong_message_rejected: !verifyNodeSignature(sig.m2, sig.s1, sig.pubkey),
    empty_message_rejected: !verifyNodeSignature('', sig.s1, sig.pubkey),
    tampered_sig_rejected: !verifyNodeSignature(sig.m1, flip(sig.s1), sig.pubkey),
    other_node_rejected: !verifyNodeSignature(sig.m1, sig.s1, pubkeys.bob)
  }
  console.log(JSON.stringify(results, null, 2))
  if (!Object.values(results).every(Boolean)) process.exit(1)
}
