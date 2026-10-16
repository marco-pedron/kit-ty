// Q6 + Q7: routed payment alice -> dave -> bob, 309 DUSD units. Latency, payer-side preimage,
// payee_pubkey from decode, HTLC in-flight limit.
import { createHash } from 'node:crypto'
import { openAll, closeAll, log, loadState, sleep, waitFor } from './lib.ts'

const { assetId } = loadState()
const nodes = await openAll()
const { alice, bob } = nodes
await waitFor('alice channel usable after restart', async () => {
  const r = await alice.account.listChannels(); return (r.channels ?? r).filter((c: any) => c.is_usable).length === 2
}, 60000)

const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309, description: 'kitty:test:1:alice' })
log('bob-invoice', inv)
const bolt11: string = inv.invoice ?? inv.bolt11
const dec = await alice.account.decodeInvoice(bolt11)
log('alice-decode', dec)
log('payee-is-bob', dec.payee_pubkey === bob.pubkey)

const before = await alice.account.listChannels()
const t0 = Date.now()
let sent: any
for (let attempt = 0; attempt < 10; attempt++) {
  sent = await alice.account.sendPayment({ invoice: bolt11 })
  log('sendPayment', { attempt, sent })
  if (sent.status !== 'Failed') break
  await sleep(2000) // gossip may not have propagated yet
}
const hash: string = sent.payment_hash
const done = await waitFor('payment terminal', async () => {
  const p = await alice.account.getPayment(hash, 'Outbound')
  const pay = p.payment ?? p
  return pay.status === 'Succeeded' || pay.status === 'Failed' ? pay : undefined
}, 30000, 250)
const ms = Date.now() - t0
log('alice-getPayment', { ms, done })
if (done.preimage) {
  const ok = createHash('sha256').update(Buffer.from(done.preimage, 'hex')).digest('hex') === hash
  log('sha256(preimage)==payment_hash', ok)
}
const bobSide = await bob.account.getPayment(hash, 'InboundAutoClaim').catch((e: Error) => e.message)
log('bob-getPayment', bobSide)
log('alice-channels-before', (before.channels ?? before).map((c: any) => ({ asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, local_sat: c.local_balance_sat, next: c.next_outbound_htlc_limit_msat })))
const after = await alice.account.listChannels()
log('alice-channels-after', (after.channels ?? after).map((c: any) => ({ asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, local_sat: c.local_balance_sat, next: c.next_outbound_htlc_limit_msat })))
log('bob-asset-balance', await bob.account.getAssetBalance(assetId))
closeAll(nodes)
