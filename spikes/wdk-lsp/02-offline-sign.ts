// H: can a member sign a ledger event with no running node and no network, from the seed only?
// Cases: (1) WDK account.sign() before unlock, (2) after unlock and shutdown,
// (3) baseline while unlocked, (4) pure-JS ed25519 app key from the seed (SPEC §9.1 fallback).
// The node is never pointed at a reachable network in cases 1 and 4.
// Usage: node 02-offline-sign.ts
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { mnemonicToSeedSync } from 'bip39'
import { ed25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import { HERE, log, errMsg, secrets, nodeConfig, UNLOCK, closeNode } from './lib.ts'
import { verifyNodeSignature, recoverSigner } from './verify.ts'

const msg = 'kitty:v1:' + JSON.stringify({ tripId: 't1', type: 'LINE_DECIDED', nonce: 'aa'.repeat(16), body: { decision: 'approve', cents: '309' } })
const dataDir = join(HERE, 'data', 'offline-alice', 'ln')
rmSync(join(HERE, 'data', 'offline-alice'), { recursive: true, force: true })

const manager = new WalletManagerRgbLightning(secrets().alice, nodeConfig('alice', { dataDir }))
const account = await manager.getAccount(0)
let pubkey: string | undefined
try {
  pubkey = Buffer.from(account.keyPair.publicKey).toString('hex')
  log('H.1.keyPair.beforeUnlock', { ok: true, pubkey })
} catch (e) { log('H.1.keyPair.beforeUnlock', { ok: false, e: errMsg(e) }) }
try {
  const sig = await account.sign(msg)
  log('H.1.sign.beforeUnlock', { ok: true, sig, verified: pubkey ? verifyNodeSignature(msg, sig, pubkey) : null })
} catch (e) { log('H.1.sign.beforeUnlock', { ok: false, e: errMsg(e) }) }

// baseline: unlocked (needs the regtest stack)
await account.unlock(UNLOCK('alice'))
const info = await account.getNodeInfo()
const sig3 = await account.sign(msg)
log('H.3.sign.unlocked', { pubkey: info.pubkey, sameAsBootstrap: info.pubkey === pubkey, verified: verifyNodeSignature(msg, sig3, info.pubkey), wrongMsgRejected: !verifyNodeSignature(msg + 'x', sig3, info.pubkey), signer: recoverSigner(msg, sig3) })

await closeNode({ name: 'alice', manager: { dispose () {} }, account, pubkey: info.pubkey })
try {
  const sig2 = await account.sign(msg)
  log('H.2.sign.afterShutdown', { ok: true, verified: verifyNodeSignature(msg, sig2, info.pubkey) })
} catch (e) { log('H.2.sign.afterShutdown', { ok: false, e: errMsg(e) }) }
try { manager.dispose() } catch {}

// fresh process-equivalent: new manager on the same dataDir, never unlocked
const m2 = new WalletManagerRgbLightning(secrets().alice, nodeConfig('alice', { dataDir }))
const a2 = await m2.getAccount(0)
try {
  const sig = await a2.sign(msg)
  log('H.1b.sign.lockedExistingNode', { ok: true, verified: verifyNodeSignature(msg, sig, info.pubkey) })
} catch (e) { log('H.1b.sign.lockedExistingNode', { ok: false, e: errMsg(e) }) }
try { m2.dispose() } catch {}

// 4: pure JS, no native code: ed25519 app key derived from the BIP-39 seed (HKDF, domain-separated)
const seed = mnemonicToSeedSync(secrets().alice)
const appPriv = hkdf(sha256, seed, utf8ToBytes('kitty'), utf8ToBytes('kitty/app-key/v1'), 32)
const appPub = ed25519.getPublicKey(appPriv)
const appSig = ed25519.sign(utf8ToBytes(msg), appPriv)
log('H.4.ed25519.fromSeed', {
  appPubkey: bytesToHex(appPub),
  verified: ed25519.verify(appSig, utf8ToBytes(msg), appPub),
  wrongMsgRejected: !ed25519.verify(appSig, utf8ToBytes(msg + 'x'), appPub),
  deterministic: bytesToHex(ed25519.getPublicKey(hkdf(sha256, mnemonicToSeedSync(secrets().alice), utf8ToBytes('kitty'), utf8ToBytes('kitty/app-key/v1'), 32))) === bytesToHex(appPub)
})
process.exit(0)
