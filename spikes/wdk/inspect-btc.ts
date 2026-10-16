import { NAMES, openAll, closeAll, log } from './lib.ts'
const nodes = await openAll()
for (const n of NAMES) {
  await nodes[n].account.sync()
  log('btc', { n, bal: await nodes[n].account.getBalanceDetails(false), unspents: ((await nodes[n].account.listUnspents(false)).unspents ?? []).map((u: any) => ({ colorable: u.utxo?.colorable, sat: u.utxo?.btc_amount, rgb: u.rgb_allocations?.length })) })
}
closeAll(nodes)
