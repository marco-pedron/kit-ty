// Q4 (part 2): send DUSD on-chain from dave's wdk-wallet-rgb to each LN node.
// LN nodes cannot create an invoice for an asset they have never seen (Rln(NotFound)),
// so the invoice is created without asset_id.
import { join } from 'node:path'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { HERE, NAMES, openAll, closeAll, log, mine, loadState, sleep } from './lib.ts'

const { assetId } = loadState()
const wm = new WalletManagerRgb((await import('./lib.ts')).secrets().dave, {
  network: 'regtest',
  indexerUrl: 'tcp://127.0.0.1:50001',
  transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
  dataDir: join(HERE, 'data', 'dave', 'onchain')
})
const dw = await wm.getAccount()
log('dave-onchain-balance-before', await dw.getTokenBalance(assetId))

const nodes = await openAll()
const plan: Record<string, number> = { alice: 10_000, bob: 10_000, charlie: 10_000, dave: 50_000 }
for (const n of NAMES) {
  const bal = await nodes[n].account.getAssetBalance(assetId).catch(() => null)
  if (bal && bal.settled > 0) { log('skip', { name: n, bal }); continue }
  const inv = await nodes[n].account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
  log('rgb-invoice', { name: n, inv })
  const res = await dw.transfer({ recipient: inv.invoice, token: assetId, amount: plan[n], feeRate: 2, minConfirmations: 1 })
  log('transfer', { name: n, res })
  // receiver ACKs the consignment, sender then broadcasts, then confirm and settle both
  await sleep(1000)
  await nodes[n].account.refreshTransfers({ skip_sync: false })
  dw.refreshWallet()
  log('mined', mine(1))
  await sleep(1500)
  await nodes[n].account.refreshTransfers({ skip_sync: false })
  dw.refreshWallet()
  log('dave-onchain-balance', dw.getRgbWallet().getAssetBalance?.(assetId) ?? await dw.getTokenBalance(assetId))
}
for (let i = 0; i < 3; i++) {
  log('mined', mine(1))
  await sleep(1500)
  dw.refreshWallet()
  for (const n of NAMES) await nodes[n].account.refreshTransfers({ skip_sync: false })
}
for (const n of NAMES) log('ln-asset-balance', { name: n, bal: await nodes[n].account.getAssetBalance(assetId).catch((e: Error) => e.message) })
log('dave-onchain-balance-after', await dw.getTokenBalance(assetId))
closeAll(nodes)
try { wm.dispose() } catch {}
