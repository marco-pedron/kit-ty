// Q4: BTC to every LN node; DUSD issued by dave's on-chain wdk-wallet-rgb (same seed,
// separate dataDir) and sent on-chain to each LN node via blinded RGB invoices.
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { HERE, NAMES, openAll, closeAll, log, mine, fund, saveState, secrets, sleep } from './lib.ts'

const onchainDir = join(HERE, 'data', 'dave', 'onchain')
mkdirSync(onchainDir, { recursive: true })
const wm = new WalletManagerRgb(secrets().dave, {
  network: 'regtest',
  indexerUrl: 'tcp://127.0.0.1:50001',
  transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
  dataDir: onchainDir
})
const dw = await wm.getAccount()
const dwAddr = dw.getAddress()
log('dave-onchain-address', dwAddr)

const nodes = await openAll()
const lnAddr: Record<string, string> = {}
for (const n of NAMES) lnAddr[n] = await nodes[n].account.getAddress()
log('ln-addresses', lnAddr)
log('same-seed-distinct-addresses', { onchain: dwAddr, ln: lnAddr.dave, distinct: dwAddr !== lnAddr.dave })

// BTC
fund(dwAddr, 1)
for (const n of NAMES) fund(lnAddr[n], 1)
log('mined', mine(1))
for (const n of NAMES) await nodes[n].account.sync()

// Colorable UTXOs
const made = await dw.createUtxos({ upTo: true, num: 5, feeRate: 2 })
log('dave-onchain-createUtxos', made)
for (const n of NAMES) {
  await nodes[n].account.createUtxos({ up_to: true, num: 10, size: null, fee_rate: 2, skip_sync: false })
}
log('mined', mine(1))

// Issue DUSD (precision 2): 10,000.00 = 1,000,000 units
const asset = dw.issueAssetNia({ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] })
log('issued', asset)
const assetId: string = asset.assetId ?? asset.asset_id
saveState({ assetId })

// Send on-chain: travellers 100.00 each, dave's LN node 500.00
const plan: Record<string, number> = { alice: 10_000, bob: 10_000, charlie: 10_000, dave: 50_000 }
for (const n of NAMES) {
  const inv = await nodes[n].account.createRgbInvoice({ min_confirmations: 1, witness: false, asset_id: assetId, assignment_kind: 'Fungible', assignment_amount: plan[n], duration_seconds: 3600 })
  log('rgb-invoice', { name: n, inv })
  const res = await dw.transfer({ recipient: inv.invoice, token: assetId, amount: plan[n], feeRate: 2, minConfirmations: 1 })
  log('transfer', { name: n, res })
  // receiver must fetch the consignment before next spend from same UTXO set
  await nodes[n].account.refreshTransfers({ skip_sync: false })
  dw.refreshWallet()
}
log('mined', mine(1))
await sleep(2000)
for (let i = 0; i < 2; i++) {
  dw.refreshWallet()
  for (const n of NAMES) await nodes[n].account.refreshTransfers({ skip_sync: false })
  log('mined', mine(1))
}
for (const n of NAMES) log('ln-asset-balance', { name: n, bal: await nodes[n].account.getAssetBalance(assetId) })
log('dave-onchain-balance', await dw.getTokenBalance(assetId))
closeAll(nodes)
try { wm.dispose() } catch {}
