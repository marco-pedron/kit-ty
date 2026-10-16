// Q2 + Q3: four WDK Lightning nodes in one Node process, unlocked on regtest.
import { NAMES, openNode, closeAll, log, saveState, type Node } from './lib.ts'

const nodes: Record<string, Node> = {}
const t0 = Date.now()
for (const n of NAMES) {
  const t = Date.now()
  nodes[n] = await openNode(n)
  log('unlock', { name: n, pubkey: nodes[n].pubkey, ms: Date.now() - t })
}
const pubkeys = Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, v.pubkey]))
saveState({ pubkeys })
log('all-unlocked', { ms: Date.now() - t0, distinct: new Set(Object.values(pubkeys)).size })
const info = await nodes.dave.account.getNodeInfo()
log('dave-nodeinfo', info)
const addr = await nodes.alice.account.getAddress()
log('alice-address', addr)
closeAll(nodes)
