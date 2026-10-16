// Q5: trip channel traveller -> dave (5000 DUSD) and liquidity channel dave -> traveller
// (3000 DUSD), capacity 1,000,000 sat, for alice, bob and charlie. Count blocks to usable.
import { openAll, closeAll, log, mine, loadState, saveState, sleep, PEER_PORT } from './lib.ts'

const { assetId } = loadState()
const nodes = await openAll()
const dave = nodes.dave
const daveUri = `${dave.pubkey}@127.0.0.1:${PEER_PORT.dave}`
const travellers = ['alice', 'bob', 'charlie'] as const

const base = { capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, public: true, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 }

const existing = async () => { const r = await dave.account.listChannels(); return (r.channels ?? r) as any[] }
for (const t of travellers) {
  await nodes[t].account.connectPeer(daveUri)
  const mine2 = (await existing()).filter(c => c.peer_pubkey === nodes[t].pubkey)
  // trip channel: opened by traveller, so on dave's side asset_remote_amount > 0 at open
  if (!mine2.some(c => c.asset_remote_amount === 5000 || c.asset_local_amount === 0 && c.asset_remote_amount > 0)) {
    const trip = await nodes[t].account.openChannel({ ...base, peer_pubkey_and_opt_addr: daveUri, asset_amount: 5000 })
    log('open-trip', { t, trip })
    await sleep(1500)
  }
  if (!mine2.some(c => c.asset_local_amount === 3000)) {
    // dave's DUSD sit in one allocation: the change of his previous open must confirm first
    let waited = 0
    for (;;) {
      await dave.account.sync(); await dave.account.refreshTransfers({ skip_sync: false })
      const b = await dave.account.getAssetBalance(assetId)
      if (b.spendable >= 3000) break
      mine(1); waited++; await sleep(2000)
      if (waited > 10) throw new Error('dave DUSD never spendable')
    }
    log('blocks-waited-before-dave-open', { t, waited })
    const liq = await dave.account.openChannel({ ...base, peer_pubkey_and_opt_addr: `${nodes[t].pubkey}@127.0.0.1:${PEER_PORT[t]}`, asset_amount: 3000 })
    log('open-liquidity', { t, liq })
    await sleep(1500)
  }
}

const summary = (chs: any[]) => chs.map(c => ({ id: c.channel_id?.slice(0, 8), peer: c.peer_pubkey?.slice(0, 8), status: c.status, ready: c.ready, usable: c.is_usable, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, cap: c.capacity_sat, outMsat: c.outbound_balance_msat, nextHtlcMsat: c.next_outbound_htlc_limit_msat }))
const list = async (n: any) => { const r = await n.account.listChannels(); return r.channels ?? r }

log('dave-channels-opening', summary(await list(dave)))
let blocks = 0
for (; blocks < 12; blocks++) {
  const chs = await list(dave)
  if (chs.length === 6 && chs.every((c: any) => c.is_usable)) break
  mine(1)
  blocks
  await sleep(2500)
  for (const n of Object.values(nodes)) await n.account.sync()
}
log('blocks-to-usable', blocks)
log('dave-channels', summary(await list(dave)))
log('alice-channels', summary(await list(nodes.alice)))
saveState({ channelsOpenedAt: Date.now() })
closeAll(nodes)
