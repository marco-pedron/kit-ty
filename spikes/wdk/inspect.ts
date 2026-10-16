import { join } from 'node:path'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { HERE, openNode, log, loadState, secrets, mine, sleep } from './lib.ts'
const { assetId } = loadState()
const wm = new WalletManagerRgb(secrets().dave, { network: 'regtest', indexerUrl: 'tcp://127.0.0.1:50001', transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc', dataDir: join(HERE, 'data', 'dave', 'onchain') })
const dw = await wm.getAccount()
const alice = await openNode('alice')
for (let i = 0; i < 3; i++) {
  await alice.account.refreshTransfers({ skip_sync: false })
  dw.refreshWallet()
  mine(1); await sleep(1500)
}
log('dave-transfers', dw.listTransfers(assetId).map((t: any) => ({ idx: t.idx, status: t.status, kind: t.kind, amt: t.requestedAssignment ?? t.amount, txid: t.txid })))
log('dave-balance', dw.getRgbWallet().getAssetBalance?.(assetId))
log('alice-assets', await alice.account.listAssets())
try { alice.manager.dispose() } catch {}
try { wm.dispose() } catch {}
