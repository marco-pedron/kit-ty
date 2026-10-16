// Run 2: the whole flow in ONE process, fresh seeds and dataDirs, alice/bob/dave only.
// Lessons from run 1: RGB channels are funded from the colored wallet; the VLS signer never
// announces channels, so channels are private and dave must forward to private channels
// (enableVirtualChannelsV0); VLS state is in memory only, so no restart in between.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { HERE, openNode, log, mine, fund, sleep, waitFor, PEER_PORT, bcli, saveState, secrets, type Node } from './lib.ts'

const step = (s: string) => log('STEP', s)
const ts = () => Date.now()

// ---------- nodes
step('open nodes')
const alice = await openNode('alice'), bob = await openNode('bob'), dave = await openNode('dave')
const all: Node[] = [alice, bob, dave]
log('pubkeys', { alice: alice.pubkey, bob: bob.pubkey, dave: dave.pubkey })
const onchainDir = join(HERE, 'data', 'dave', 'onchain'); mkdirSync(onchainDir, { recursive: true })
const wm = new WalletManagerRgb(secrets().dave, { network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc', dataDir: onchainDir })
const dw = await wm.getAccount()

// ---------- BTC + colored UTXOs (channels are funded from the colored wallet)
step('fund')
fund(dw.getAddress(), 1)
for (const n of all) fund(await n.account.getAddress(), 1)
mine(1); await sleep(2000)
for (const n of all) await n.account.sync()
await dw.createUtxos({ upTo: false, num: 6, size: 32_000, feeRate: 2 })
for (const n of all) await n.account.createUtxos({ up_to: false, num: 4, size: 1_100_000, fee_rate: 2, skip_sync: false })
mine(1); await sleep(2000)
for (const n of all) await n.account.sync()

// ---------- DUSD issue + on-chain distribution
step('issue')
const asset = dw.issueAssetNia({ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] })
const assetId: string = asset.assetId
saveState({ assetId, pubkeys: { alice: alice.pubkey, bob: bob.pubkey, dave: dave.pubkey } })
log('issued', assetId)
async function sendOnchain (to: Node, amount: number) {
  const inv = await to.account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
  const res = await dw.transfer({ recipient: inv.invoice, token: assetId, amount, feeRate: 2, minConfirmations: 1 })
  await sleep(1000)
  await to.account.refreshTransfers({ skip_sync: false }); dw.refreshWallet()
  mine(1); await sleep(2000)
  await to.account.refreshTransfers({ skip_sync: false }); dw.refreshWallet()
  log('sent-onchain', { to: to.name, amount, txid: res.hash, bal: (await to.account.getAssetBalance(assetId)).settled })
}
// two allocations for dave so he can open two channels without waiting for his change
await sendOnchain(dave, 25_000)
await sendOnchain(dave, 25_000)
await sendOnchain(dave, 25_000)

// ---------- Q5 private channels, capacity 1,000,000 sat
step('channels')
const base = { capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 }
const daveUri = `${dave.pubkey}@127.0.0.1:${PEER_PORT.dave}`
await alice.account.connectPeer(daveUri); await bob.account.connectPeer(daveUri); await sleep(1000)
// ln-lsp shape: dave opens ONE private channel per traveller with D + L DUSD and pushes D to the
// traveller (dave refuses inbound non-virtual channels when forwarding to private channels is on)
for (const t of [alice, bob]) {
  log(`open-lsp dave->${t.name}`, await dave.account.openChannel({ ...base, peer_pubkey_and_opt_addr: `${t.pubkey}@127.0.0.1:${PEER_PORT[t.name]}`, asset_amount: 8000, push_asset_amount: 5000, push_msat: 200_000_000 }).catch((e: Error) => e.message))
  await sleep(1500)
}
const chans = async (n: Node) => { const r = await n.account.listChannels(); return (r.channels ?? r) as any[] }
let blocks = 0
await waitFor('channels usable', async () => {
  const d = await chans(dave)
  if (d.length >= 2 && d.every(c => c.is_usable)) return true
  mine(1); blocks++; await sleep(2000); for (const n of all) await n.account.sync()
  return false
}, 180000, 100)
log('Q5-blocks-to-usable', blocks)
log('dave-channels', (await chans(dave)).map(c => ({ peer: c.peer_pubkey.slice(0, 8), pub: c.public, usable: c.is_usable, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, next: c.next_outbound_htlc_limit_msat })))

// ---------- Q6 routed payment alice -> dave -> bob, 309
step('pay')
const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309 })
const dec = await alice.account.decodeInvoice(inv.invoice)
log('decode', { payee_is_bob: dec.payee_pubkey === bob.pubkey, asset_amount: dec.asset_amount, asset_id_ok: dec.asset_id === assetId })
const t0 = ts()
const sent = await alice.account.sendPayment({ invoice: inv.invoice })
const done = await waitFor('payment terminal', async () => {
  const p = await alice.account.getPayment(sent.payment_hash, 'Outbound')
  return p.status === 'Succeeded' || p.status === 'Failed' ? p : undefined
}, 40000, 250).catch((e: Error) => ({ status: e.message }))
log('Q6-result', { ms: ts() - t0, status: (done as any).status, preimage: (done as any).preimage, blocksMinedDuring: 0 })
if ((done as any).preimage) log('Q6-sha256(preimage)==hash', createHash('sha256').update(Buffer.from((done as any).preimage, 'hex')).digest('hex') === sent.payment_hash)
log('bob-side', await bob.account.getPayment(sent.payment_hash, 'InboundAutoClaim').catch((e: Error) => e.message))
log('balances', { alice: await alice.account.getAssetBalance(assetId), bob: await bob.account.getAssetBalance(assetId).catch(() => null) })

// ---------- Q6b reverse: bob -> dave -> alice, 350 (alice has a public-unannounced trip + private liquidity)
const inv2 = await alice.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 350 })
const t1 = ts()
const sent2 = await bob.account.sendPayment({ invoice: inv2.invoice })
const done2 = await waitFor('payment2 terminal', async () => {
  const p = await bob.account.getPayment(sent2.payment_hash, 'Outbound')
  return p.status === 'Succeeded' || p.status === 'Failed' ? p : undefined
}, 40000, 250).catch((e: Error) => ({ status: e.message }))
log('Q6b-bob-to-alice', { ms: ts() - t1, status: (done2 as any).status, preimage: (done2 as any).preimage })
log('balances-after-2', { alice: await alice.account.getAssetBalance(assetId), bob: await bob.account.getAssetBalance(assetId), dave: await dave.account.getAssetBalance(assetId) })

// ---------- Q7
const trip = (await chans(alice))[0]
log('Q7', { next_outbound_htlc_limit_msat: trip?.next_outbound_htlc_limit_msat, outbound_balance_msat: trip?.outbound_balance_msat })

// ---------- Q8 signing
step('sign')
const m1 = 'kitty:v1:trip-1:nonce-a', m2 = 'kitty:v1:trip-1:nonce-b'
const s1 = await alice.account.sign(m1), s2 = await alice.account.sign(m2)
log('Q8', { s1, s2, different: s1 !== s2, ok: await alice.account.verify(m1, s1), wrongMsg: await alice.account.verify(m2, s1), empty: await alice.account.verify('', s1), byBob: await bob.account.verify(m1, s1) })
saveState({ sig: { pubkey: alice.pubkey, m1, s1, m2, s2 } })

// ---------- Q10 coop close dave -> bob liquidity, same process
step('close')
const bobCh = (await chans(dave)).find(c => c.peer_pubkey === bob.pubkey)
log('closing', { id: bobCh.channel_id.slice(0, 8), pub: bobCh.public, asset: `${bobCh.asset_local_amount}/${bobCh.asset_remote_amount}` })
const daveBefore = (await dave.account.getAssetBalance(assetId)).settled
const bobBefore = (await bob.account.getAssetBalance(assetId).catch(() => ({ settled: 0 }))).settled
await waitFor('close accepted', async () => {
  try { await dave.account.closeChannel({ channel_id: bobCh.channel_id, peer_pubkey: bob.pubkey, force: false }); return true } catch (e) { log('close-retry', (e as Error).message); return false }
}, 60000, 3000)
const mp = await waitFor('close tx in mempool', async () => { const m = JSON.parse(bcli('getrawmempool')); return m.length ? m : undefined }, 60000, 1000).catch((e: Error) => e.message)
log('Q10-mempool', mp)
let cb = 0
for (; cb < 14; cb++) {
  mine(1); await sleep(2500)
  await bob.account.refreshTransfers({ skip_sync: false }); await dave.account.refreshTransfers({ skip_sync: false })
  const b = (await bob.account.getAssetBalance(assetId).catch(() => ({ settled: 0 }))).settled
  log('close-progress', { block: cb + 1, bobSettled: b, daveSettled: (await dave.account.getAssetBalance(assetId)).settled, daveBefore })
  if (b > bobBefore) { cb++; break }
}
log('Q10-blocks-to-bob-dusd', cb)
log('dave-channels-end', (await chans(dave)).map(c => ({ peer: c.peer_pubkey.slice(0, 8), asset: `${c.asset_local_amount}/${c.asset_remote_amount}` })))
step('done')
for (const n of all) { try { n.manager.dispose() } catch {} }
try { wm.dispose() } catch {}
