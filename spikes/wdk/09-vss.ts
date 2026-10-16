// Q9: VSS backup and restore of bob, in one process (dave stays up, his VLS state intact).
// bob: VSS on. dave opens an ln-lsp channel to bob, bob pays dave, vssBackup, bob "loses the
// phone" (shutdown + dataDir moved away), new bob with same seed + empty dataDir + clearVssFence,
// unlock, then check channel, DUSD and a new payment.
import { join } from 'node:path'
import { mkdirSync, renameSync } from 'node:fs'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { HERE, openNode, log, mine, fund, sleep, waitFor, PEER_PORT, saveState, secrets, type Node } from './lib.ts'

const VSS = 'http://127.0.0.1:8081/vss'
const step = (s: string) => log('STEP', s)
const bobDir = join(HERE, 'data', 'bob', 'ln')

step('open')
const dave = await openNode('dave')
let bob = await openNode('bob', { vssUrl: VSS })
log('bob-vssStatus', await bob.account.vssStatus())
const onchainDir = join(HERE, 'data', 'dave', 'onchain'); mkdirSync(onchainDir, { recursive: true })
const wm = new WalletManagerRgb(secrets().dave, { network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc', dataDir: onchainDir })
const dw = await wm.getAccount()

step('fund+issue')
fund(dw.getAddress(), 1); fund(await dave.account.getAddress(), 1); fund(await bob.account.getAddress(), 1)
mine(1); await sleep(2000); await dave.account.sync(); await bob.account.sync()
await dw.createUtxos({ upTo: false, num: 4, size: 32_000, feeRate: 2 })
await dave.account.createUtxos({ up_to: false, num: 3, size: 1_100_000, fee_rate: 2, skip_sync: false })
await bob.account.createUtxos({ up_to: false, num: 3, size: 1_100_000, fee_rate: 2, skip_sync: false })
mine(1); await sleep(2000); await dave.account.sync(); await bob.account.sync()
const assetId: string = dw.issueAssetNia({ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] }).assetId
saveState({ assetId })
const inv0 = await dave.account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
await dw.transfer({ recipient: inv0.invoice, token: assetId, amount: 25_000, feeRate: 2, minConfirmations: 1 })
await sleep(1000); await dave.account.refreshTransfers({ skip_sync: false }); dw.refreshWallet()
mine(1); await sleep(2000); await dave.account.refreshTransfers({ skip_sync: false }); dw.refreshWallet()
log('dave-dusd', (await dave.account.getAssetBalance(assetId)).settled)

step('channel dave->bob')
await bob.account.connectPeer(`${dave.pubkey}@127.0.0.1:${PEER_PORT.dave}`); await sleep(1000)
await dave.account.openChannel({ peer_pubkey_and_opt_addr: `${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`, capacity_sat: 1_000_000, push_msat: 200_000_000, asset_id: assetId, asset_amount: 8000, push_asset_amount: 5000, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 })
const chans = async (n: Node) => { const r = await n.account.listChannels(); return (r.channels ?? r) as any[] }
await waitFor('usable', async () => {
  const c = await chans(bob); if (c.length && c[0].is_usable) return true
  mine(1); await sleep(2000); await bob.account.sync(); await dave.account.sync(); return false
}, 120000, 100)

async function bobPaysDave (units: number, label: string) {
  const inv = await dave.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: units })
  const t0 = Date.now()
  const sent = await bob.account.sendPayment({ invoice: inv.invoice })
  const p = await waitFor(label, async () => {
    const r = await bob.account.getPayment(sent.payment_hash, 'Outbound')
    return r.status === 'Succeeded' || r.status === 'Failed' ? r : undefined
  }, 40000, 250).catch((e: Error) => ({ status: e.message }))
  log(label, { ms: Date.now() - t0, status: (p as any).status, sendStatus: sent.status })
  return (p as any).status
}
await bobPaysDave(100, 'pay-before-backup')
const chBefore = (await chans(bob)).map(c => ({ id: c.channel_id, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, sat: c.local_balance_sat }))
log('bob-before', { chans: chBefore, dusd: await bob.account.getAssetBalance(assetId) })

step('vssBackup')
let t = Date.now()
const v1 = await bob.account.vssBackup().catch((e: Error) => ({ error: e.message }))
log('vssBackup-1', { v1, ms: Date.now() - t })
// usable right after the backup, without lock/unlock?
await bobPaysDave(50, 'pay-after-backup')
t = Date.now()
const v2 = await bob.account.vssBackup().catch((e: Error) => ({ error: e.message }))
log('vssBackup-2', { v2, ms: Date.now() - t })
const chFinal = (await chans(bob)).map(c => ({ id: c.channel_id, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, sat: c.local_balance_sat }))

step('lose phone')
try { bob.manager.dispose() } catch {}
renameSync(bobDir, bobDir + '-lost')
mkdirSync(bobDir, { recursive: true })
await sleep(2000)

step('restore')
const { default: WalletManagerRgbLightning } = await import('@utexo/wdk-rgb-lightning')
const mgr = new WalletManagerRgbLightning(secrets().bob, { network: 'regtest', dataDir: bobDir, ldkPeerListeningPort: PEER_PORT.bob + 10, vssUrl: VSS, vssAllowHttp: true })
const acc = await mgr.getAccount(0)
log('clearVssFence', await acc.clearVssFence('unused-with-external-signer').catch((e: Error) => ({ error: e.message })))
t = Date.now()
const un = await acc.unlock({ bitcoind_rpc_username: 'user', bitcoind_rpc_password: 'password', bitcoind_rpc_host: '127.0.0.1', bitcoind_rpc_port: 18443, indexer_url: 'tcp://127.0.0.1:50001', proxy_endpoint: 'rpc://127.0.0.1:3000/json-rpc', announce_addresses: [], announce_alias: 'bob' }).catch((e: Error) => ({ error: e.message }))
log('unlock-after-restore', { un, ms: Date.now() - t })
const info = await acc.getNodeInfo().catch((e: Error) => ({ error: e.message }))
log('restored-nodeinfo', { samePubkey: info.pubkey === bob.pubkey, num_channels: info.num_channels })
bob = { name: 'bob', manager: mgr, account: acc, pubkey: info.pubkey }
await acc.connectPeer(`${dave.pubkey}@127.0.0.1:${PEER_PORT.dave}`).catch((e: Error) => log('connect', e.message))
await sleep(5000)
const chAfter = (await chans(bob).catch(() => [])).map(c => ({ id: c.channel_id, usable: c.is_usable, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, sat: c.local_balance_sat }))
log('compare', { before: chFinal, after: chAfter, dusd: await acc.getAssetBalance(assetId).catch((e: Error) => e.message) })
await bobPaysDave(25, 'pay-after-restore')
log('dave-channels', (await chans(dave)).map(c => ({ peer: c.peer_pubkey.slice(0, 8), status: c.status, usable: c.is_usable, asset: `${c.asset_local_amount}/${c.asset_remote_amount}` })))
step('done')
for (const n of [dave, bob]) { try { n.manager.dispose() } catch {} }
try { wm.dispose() } catch {}
