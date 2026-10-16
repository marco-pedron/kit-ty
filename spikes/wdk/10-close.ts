// Q10: cooperative close of every dave channel (needed anyway: public channels are never
// announced under the VLS signer). Count blocks until the DUSD are settled on-chain again.
import { NAMES, openAll, closeAll, log, mine, loadState, sleep } from './lib.ts'

const { assetId } = loadState()
const nodes = await openAll()
const dave = nodes.dave
await sleep(3000) // let peers reconnect
const chs = await dave.account.listChannels()
const list = (chs.channels ?? chs) as any[]
const before: Record<string, any> = {}
for (const n of NAMES) before[n] = await nodes[n].account.getAssetBalance(assetId)
log('balances-before', before)
for (const c of list) {
  await dave.account.closeChannel({ channel_id: c.channel_id, peer_pubkey: c.peer_pubkey, force: false })
  log('close', { id: c.channel_id.slice(0, 8), peer: c.peer_pubkey.slice(0, 8), asset: `${c.asset_local_amount}/${c.asset_remote_amount}` })
}
await sleep(3000)
log('mempool', JSON.parse((await import('./lib.ts')).bcli('getrawmempool')).length)
log('dave-channels-after-close', ((await dave.account.listChannels()).channels ?? []).length)

let blocks = 0
const target: Record<string, number> = { alice: 10_000, bob: 10_000, charlie: 10_000 }
for (; blocks < 15; blocks++) {
  mine(1)
  await sleep(2500)
  const row: Record<string, number> = {}
  for (const n of NAMES) {
    await nodes[n].account.refreshTransfers({ skip_sync: false })
    row[n] = (await nodes[n].account.getAssetBalance(assetId)).settled
  }
  log('settled', { block: blocks + 1, ...row })
  if (['alice', 'bob', 'charlie'].every(n => row[n] >= target[n]) && row.dave >= 50_000) { blocks++; break }
}
log('blocks-to-dusd-settled', blocks)
closeAll(nodes)
