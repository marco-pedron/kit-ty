import { openNode, log, loadState } from './lib.ts'
const { assetId } = loadState()
const d = await openNode('dave')
const r = await d.account.listChannels()
console.log(JSON.stringify(r, null, 1).slice(0, 3000))
log('dave-asset', await d.account.getAssetBalance(assetId))
log('dave-transfers', ((await d.account.listTransfers(assetId)).transfers ?? []).map((t: any) => ({ idx: t.idx, status: t.status, kind: t.kind, amt: t.requested_assignment ?? t.assignments, txid: t.txid?.slice(0, 10) })))
try { d.manager.dispose() } catch {}
