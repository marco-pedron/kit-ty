// Q5/Q6/Q7/Q8/Q10 in ONE process lifetime (the 0.1.0-beta.11 VLS signer keeps channel state
// only in memory, so a restart loses it). Private channels: the VLS signer refuses to sign
// channel_announcement, so public channels are never announced and the payer has no graph;
// routing to bob must come from route hints in bob's invoice.
import { createHash } from 'node:crypto'
import { openAll, closeAll, log, mine, loadState, sleep, waitFor, PEER_PORT, bcli } from './lib.ts'

const { assetId } = loadState()
const nodes = await openAll()
const { alice, bob, dave } = nodes
const daveUri = `${dave.pubkey}@127.0.0.1:${PEER_PORT.dave}`
const base = { capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 }
const chans = async (n: any) => { const r = await n.account.listChannels(); return (r.channels ?? r) as any[] }
const usable = async (n: any, peer: string) => (await chans(n)).filter(c => c.peer_pubkey === peer && c.is_usable && !c.public)

// --- Q5: private trip channel alice -> dave and private liquidity dave -> bob
await alice.account.connectPeer(daveUri)
await bob.account.connectPeer(daveUri)
await sleep(1000)
await sleep(4000) // reconnect after restart
log('existing-private', { alice: (await chans(alice)).map(c => ({ id: c.channel_id.slice(0, 8), status: c.status, usable: c.is_usable, pub: c.public, asset: `${c.asset_local_amount}/${c.asset_remote_amount}` })), bob: (await chans(bob)).map(c => ({ id: c.channel_id.slice(0, 8), status: c.status, usable: c.is_usable, pub: c.public, asset: `${c.asset_local_amount}/${c.asset_remote_amount}` })) })
if (!(await usable(alice, dave.pubkey)).length) log('open-trip', await alice.account.openChannel({ ...base, peer_pubkey_and_opt_addr: daveUri, asset_amount: 2000 }))
if (!(await usable(bob, dave.pubkey)).length) log('open-liq', await dave.account.openChannel({ ...base, peer_pubkey_and_opt_addr: `${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`, asset_amount: 2000 }))
let blocks = 0
await waitFor('private channels usable', async () => {
  if ((await usable(alice, dave.pubkey)).length >= 1 && (await usable(bob, dave.pubkey)).length >= 1) return true
  mine(1); blocks++; await sleep(2000)
  for (const n of [alice, bob, dave]) await n.account.sync()
  return false
}, 120000, 100)
log('private-usable-after-blocks', blocks)
const aliceTrip = (await usable(alice, dave.pubkey))[0]
log('Q7-alice-trip', { cap: aliceTrip.capacity_sat, outbound_msat: aliceTrip.outbound_balance_msat, next_outbound_htlc_limit_msat: aliceTrip.next_outbound_htlc_limit_msat, in_flight_payments: Math.floor(aliceTrip.next_outbound_htlc_limit_msat / 3_000_000), total_payments: Math.floor(aliceTrip.outbound_balance_msat / 3_000_000) })

// --- Q6: routed payment with route hints
const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309 })
const bolt11: string = inv.invoice
const dec = await alice.account.decodeInvoice(bolt11)
log('decode', { payee_is_bob: dec.payee_pubkey === bob.pubkey, dec })
const t0 = Date.now()
const sent = await alice.account.sendPayment({ invoice: bolt11 })
log('sendPayment', sent)
const done = await waitFor('payment terminal', async () => {
  const p = await alice.account.getPayment(sent.payment_hash, 'Outbound')
  return p.status === 'Succeeded' || p.status === 'Failed' ? p : undefined
}, 30000, 250)
log('Q6-result', { ms: Date.now() - t0, status: done.status, preimage: done.preimage })
if (done.preimage) log('sha256(preimage)==hash', createHash('sha256').update(Buffer.from(done.preimage, 'hex')).digest('hex') === sent.payment_hash)
log('bob-side', await bob.account.getPayment(sent.payment_hash, 'InboundAutoClaim'))
log('alice-trip-after', (await usable(alice, dave.pubkey)).map(c => ({ asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, local_sat: c.local_balance_sat })))

// --- Q8: message signing with node identity
const m1 = 'kitty:v1:trip-1:nonce-a', m2 = 'kitty:v1:trip-1:nonce-b'
const s1 = await alice.account.sign(m1), s2 = await alice.account.sign(m2)
log('Q8-sign', { s1, s2, different: s1 !== s2 })
log('Q8-verify', {
  ok: await alice.account.verify(m1, s1),
  wrongMsg: await alice.account.verify(m2, s1),
  emptyMsg: await alice.account.verify('', s1),
  bobVerifiesAliceSig: await bob.account.verify(m1, s1)
})
log('Q8-raw-verifyMessage', alice.manager._binding.ensureNode().verifyMessage(m1, s1))
const { saveState } = await import('./lib.ts')
saveState({ sig: { pubkey: alice.pubkey, m1, s1, m2, s2 } })

// --- Q10: cooperative close dave <-> bob (liquidity channel), same process
const bobLiq = (await usable(dave, bob.pubkey))[0]
await dave.account.closeChannel({ channel_id: bobLiq.channel_id, peer_pubkey: bob.pubkey, force: false })
log('close-requested', bobLiq.channel_id)
const mp = await waitFor('close tx in mempool', async () => { const m = JSON.parse(bcli('getrawmempool')); return m.length ? m : undefined }, 60000, 1000).catch(e => e.message)
log('mempool', mp)
const bobBefore = (await bob.account.getAssetBalance(assetId)).settled
let cb = 0
for (; cb < 14; cb++) {
  mine(1); await sleep(2500)
  await bob.account.refreshTransfers({ skip_sync: false }); await dave.account.refreshTransfers({ skip_sync: false })
  const b = (await bob.account.getAssetBalance(assetId)).settled
  log('close-progress', { block: cb + 1, bobSettled: b, daveSettled: (await dave.account.getAssetBalance(assetId)).settled })
  if (b > bobBefore) { cb++; break }
}
log('Q10-blocks-to-bob-dusd', cb)
closeAll(nodes)
