// Q6 diagnosis: does the network graph fill up if nodes stay online longer?
import { openAll, closeAll, log, sleep, mine } from './lib.ts'
const nodes = await openAll()
const t0 = Date.now()
for (let i = 0; i < 24; i++) {
  const row: Record<string, number> = {}
  for (const n of ['alice', 'bob', 'dave'] as const) row[n] = (await nodes[n].account.getNodeInfo()).network_channels
  log('graph', { s: Math.round((Date.now() - t0) / 1000), ...row })
  if (row.alice >= 4) break
  if (i === 6) log('mined', mine(1))
  await sleep(5000)
}
closeAll(nodes)
