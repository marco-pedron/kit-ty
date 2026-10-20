// D (follow-up): after the post-restore force close, mine and watch the member's DUSD.
// Usage: node 09e-after-close.ts dave <rounds>
import { log, openNode, closeNode, mine, sleep, loadState, bcli, type Name } from './lib.ts'
const name = process.argv[2] as Name
const rounds = Number(process.argv[3] ?? 6)
const { assetId } = loadState()
const n = await openNode(name, { vssUrl: 'http://127.0.0.1:8091/vss' })
const mp = JSON.parse(bcli('getrawmempool')) as string[]
log(`D.afterClose.${name}.mempool`, mp.map(t => { const tx = JSON.parse(bcli('getrawtransaction', t, 'true')); return { txid: t.slice(0, 12), inputs: tx.vin.map((v: any) => `${v.txid.slice(0, 12)}:${v.vout}`) } }))
for (let i = 0; i < rounds; i++) {
  mine(i === 0 ? 1 : 25); await sleep(3000)
  await n.account.sync(); await n.account.refreshTransfers({ skip_sync: false }).catch(() => null)
  log(`D.afterClose.${name}.poll`, { round: i, dusd: await n.account.getAssetBalance(assetId).catch((e: unknown) => String(e)), btc: await n.account.getBalance(), channels: ((await n.account.listChannels()) as any[]).length })
}
await closeNode(n)
process.exit(0)
