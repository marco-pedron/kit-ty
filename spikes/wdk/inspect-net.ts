import { openAll, closeAll, log, sleep } from './lib.ts'
const nodes = await openAll()
await sleep(8000)
for (const n of ['alice', 'bob', 'dave'] as const) {
  const i = await nodes[n].account.getNodeInfo()
  log('net', { n, network_nodes: i.network_nodes, network_channels: i.network_channels, peers: i.num_peers, usable: i.num_usable_channels })
}
log('alice-networkinfo', await nodes.alice.account.getNetworkInfo())
log('alice-peers', await nodes.alice.account.listPeers())
closeAll(nodes)
