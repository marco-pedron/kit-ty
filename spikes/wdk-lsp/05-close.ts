// C: after closing an RGB channel, do the DUSD come back to each member's on-chain wallet?
//   node 05-close.ts open      alice -> bob RGB channel (DUSD 8000, push 3000), pay 309 DUSD
//   node 05-close.ts coop      cooperative close, mine, refresh, compare on-chain DUSD balances
//   node 05-close.ts force     open a second RGB channel and force-close it (unilateral)
// Use KITTY_PERMISSIVE=1 (strict signer cannot fund channels, see B).
import { HERE, log, errMsg, openNode, closeNode, mine, waitFor, usableChannel, payAndWait, saveState, loadState, PEER_PORT, sleep, bcli } from './lib.ts'

const phase = process.argv[2]
const assetId = loadState().assetId
const alice = await openNode('alice')
const bob = await openNode('bob')
await alice.account.connectPeer(`${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`).catch(() => null)
await sleep(1500)

const bal = async (n: any) => {
  await n.account.refreshTransfers({ skip_sync: false }).catch(() => null)
  return n.account.getAssetBalance(assetId).catch((e: unknown) => ({ err: errMsg(e) }))
}
const rgbChannel = async () => ((await alice.account.listChannels()) as any[]).find(c => c.asset_id === assetId && c.peer_pubkey === bob.pubkey)

async function openRgb (tag: string) {
  const r = await alice.account.openChannel({ peer_pubkey_and_opt_addr: `${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`, capacity_sat: 1_000_000, push_msat: 200_000_000, asset_id: assetId, asset_amount: 8000, push_asset_amount: 3000, public: false, with_anchors: true })
  log(`C.${tag}.openChannel`, r)
  await sleep(3000); mine(6)
  const ch = await waitFor('rgb usable', async () => { await alice.account.sync(); await bob.account.sync(); const c = await rgbChannel(); return c?.is_usable ? c : undefined }, 120000, 1500)
  log(`C.${tag}.usable`, { id: ch.channel_id, funding: ch.funding_txid, local: ch.asset_local_amount, remote: ch.asset_remote_amount })
  return ch
}

try {
  if (phase === 'open') {
    log('C.open.balancesBefore', { alice: await bal(alice), bob: await bal(bob) })
    const ch = await openRgb('open')
    saveState({ rgbChannel: ch.channel_id })
    const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309 })
    log('C.open.pay309', await payAndWait(alice, inv.invoice))
    const c2 = await rgbChannel()
    log('C.open.channelAfterPay', { local: c2.asset_local_amount, remote: c2.asset_remote_amount })
    log('C.open.balancesAfter', { alice: await bal(alice), bob: await bal(bob) })
  } else if (phase === 'coop') {
    const ch = await rgbChannel()
    log('C.coop.before', { id: ch?.channel_id, local: ch?.asset_local_amount, remote: ch?.asset_remote_amount, alice: await bal(alice), bob: await bal(bob) })
    const r = await alice.account.closeChannel({ channel_id: ch.channel_id, peer_pubkey: bob.pubkey, force: false })
    log('C.coop.close', r)
    const t0 = Date.now()
    let last: any = {}
    for (let i = 0; i < 20; i++) {
      await sleep(2000); mine(1)
      await alice.account.sync(); await bob.account.sync()
      last = { block: i + 1, alice: await bal(alice), bob: await bal(bob), channelGone: !(await rgbChannel()) }
      if (i % 3 === 2) log('C.coop.poll', last)
      if (last.alice.spendable >= 20000 - 8000 + 8000 - 3000 - 309 && last.bob.spendable >= 3309) break
    }
    log('C.coop.final', { ...last, secs: Math.round((Date.now() - t0) / 1000) })
  } else if (phase === 'force') {
    const ch = await openRgb('force')
    const before = { alice: await bal(alice), bob: await bal(bob) }
    log('C.force.before', before)
    try {
      const r = await alice.account.closeChannel({ channel_id: ch.channel_id, peer_pubkey: bob.pubkey, force: true })
      log('C.force.close', r)
    } catch (e) { log('C.force.close.error', errMsg(e)) }
    await sleep(3000)
    const mempool = JSON.parse(bcli('getrawmempool'))
    log('C.force.mempool', { count: mempool.length, hasFundingSpend: mempool.length > 0 })
    mine(1); await sleep(2000)
    for (let i = 0; i < 8; i++) {
      mine(20); await sleep(2500)
      await alice.account.sync(); await bob.account.sync()
      log('C.force.poll', { blocks: 1 + 20 * (i + 1), alice: await bal(alice), bob: await bal(bob), channel: (await rgbChannel())?.channel_id ?? null })
    }
  }
} catch (e) { log(`C.${phase}.error`, errMsg(e)) }
await closeNode(alice); await closeNode(bob)
process.exit(0)
