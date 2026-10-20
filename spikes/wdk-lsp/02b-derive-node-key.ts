// H (follow-up): derive the node identity key from the seed in pure JS, without the native
// signer, and sign in the Lightning message format. Tries the two VLS key derivation styles.
// Usage: node 02b-derive-node-key.ts   (expects the pubkey logged by 02-offline-sign.ts)
import { mnemonicToSeedSync } from 'bip39'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hmac } from '@noble/hashes/hmac'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256, sha512 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils'
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import { join } from 'node:path'
import { HERE, log, secrets, nodeConfig } from './lib.ts'
import { lightningMessageHash, verifyNodeSignature } from './verify.ts'

const ZB = 'ybndrfg8ejkmcpqxot1uwisza345h769'
function zbase32Encode (b: Uint8Array): string {
  let bits = 0; let value = 0; let out = ''
  for (const byte of b) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += ZB[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ZB[(value << (5 - bits)) & 31]
  return out
}
const N = secp256k1.CURVE.n
const toBig = (b: Uint8Array) => BigInt('0x' + bytesToHex(b))
const to32 = (x: bigint) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'))
function bip32Hardened0 (seed: Uint8Array): Uint8Array {
  const I = hmac(sha512, utf8ToBytes('Bitcoin seed'), seed)
  const k = I.slice(0, 32); const c = I.slice(32)
  const data = concatBytes(new Uint8Array([0]), k, new Uint8Array([0x80, 0, 0, 0]))
  const J = hmac(sha512, c, data)
  return to32((toBig(J.slice(0, 32)) + toBig(k)) % N)
}

const mnemonic = secrets().alice
const entropy32 = mnemonicToSeedSync(mnemonic).slice(0, 32)   // per CHANGELOG 0.1.0-beta.15: first 32 bytes of the BIP-39 seed
const candidates: Record<string, Uint8Array> = {
  ldk_bip32_0h: bip32Hardened0(entropy32),
  vls_native_hkdf_nodeid: hkdf(sha256, entropy32, new Uint8Array(0), utf8ToBytes('nodeid'), 32)
}
const m = new WalletManagerRgbLightning(mnemonic, nodeConfig('alice', { dataDir: join(HERE, 'data', 'offline-alice', 'ln') }))
const expected = Buffer.from((await m.getAccount(0)).keyPair.publicKey).toString('hex')
try { m.dispose() } catch {}

const msg = 'kitty:v1:offline-test'
for (const [name, priv] of Object.entries(candidates)) {
  const pub = bytesToHex(secp256k1.getPublicKey(priv, true))
  let verified = null
  if (pub === expected) {
    const s = secp256k1.sign(lightningMessageHash(msg), priv)
    const sig = zbase32Encode(concatBytes(new Uint8Array([31 + s.recovery]), s.toCompactRawBytes()))
    verified = verifyNodeSignature(msg, sig, expected)
  }
  log('H.5.pureJsNodeKey', { style: name, matches: pub === expected, verified })
}
process.exit(0)
