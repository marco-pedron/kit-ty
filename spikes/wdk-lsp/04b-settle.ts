// Drive pending treasury -> LSP-node transfers to settlement: refresh both sides and mine.
// Usage: node 04b-settle.ts
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { HERE, log, rln, mine, sleep, loadState, INDEXER, PROXY } from './lib.ts'
const { default: WalletManagerRgb } = await import(join(HERE, '../../infra/treasury/node_modules/@utexo/wdk-wallet-rgb/index.js'))
const manager = new WalletManagerRgb(readFileSync(join(HERE, '.secrets-treasury'), 'utf8').trim(), { network: 'regtest', indexerUrl: INDEXER, transportEndpoint: PROXY, dataDir: join(HERE, 'data', 'treasury') })
const t = await manager.getAccount()
const assetId = loadState().assetId
for (let i = 0; i < 8; i++) {
  await rln('/refreshtransfers', { asset_id: null, filter: [], skip_sync: false })
  t.refreshWallet()
  mine(1); await sleep(1500)
}
log('E.lsp.settle', { lsp: await rln('/assetbalance', { asset_id: assetId }).catch(e => String(e)), treasury: t.getAssetBalance?.(assetId) ?? null })
try { manager.dispose() } catch {}
process.exit(0)
