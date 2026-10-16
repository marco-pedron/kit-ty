// Q5 prerequisite: RGB channels are funded from the colored wallet (witness amount = capacity),
// so each opener needs colored UTXOs larger than the channel capacity.
import { NAMES, openAll, closeAll, log, mine, sleep } from './lib.ts'
const nodes = await openAll()
for (const n of NAMES) {
  const num = n === 'dave' ? 4 : 2
  await nodes[n].account.createUtxos({ up_to: false, num, size: 1_100_000, fee_rate: 2, skip_sync: false })
  log('createUtxos-big', { n, num, size: 1_100_000 })
}
log('mined', mine(1))
await sleep(2000)
for (const n of NAMES) { await nodes[n].account.sync(); log('btc', { n, bal: await nodes[n].account.getBalanceDetails(false) }) }
closeAll(nodes)
