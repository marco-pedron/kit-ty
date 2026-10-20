// E/F workaround: the LSP node (UTEXO RLN, REST) opens a PRIVATE DUSD liquidity channel to each
// member, so the member's invoice carries a route hint (utexo-lsp's cron opens public ones,
// which WDK members can never announce). Then retries the routed payment (07-lsp.ts pay).
// Usage: node 07b-private-liquidity.ts
import { log, errMsg, openNode, closeNode, mine, waitFor, sleep, loadState, rln, PEER_PORT } from './lib.ts'
const { assetId, lspPubkey } = loadState()
const alice = await openNode('alice'); const bob = await openNode('bob')
for (const n of [alice, bob]) await n.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
await sleep(1500)
for (const n of [alice, bob]) {
  try {
    const r = await rln('/openchannel', { peer_pubkey_and_opt_addr: `${n.pubkey}@host.docker.internal:${PEER_PORT[n.name]}`, capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, asset_amount: 3000, public: false, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0 })
    log(`F.private.${n.name}.open`, r)
  } catch (e) { log(`F.private.${n.name}.open.error`, errMsg(e)) }
  await sleep(4000)
}
await sleep(4000); mine(6)
await waitFor('private liquidity usable', async () => {
  await alice.account.sync(); await bob.account.sync(); mine(1)
  const ok = async (n: any) => ((await n.account.listChannels()) as any[]).some(c => c.peer_pubkey === lspPubkey && !c.public && c.is_usable && c.asset_remote_amount === 3000)
  return (await ok(alice)) && (await ok(bob))
}, 120000, 2000).catch(e => log('F.private.wait', errMsg(e)))
log('F.private.lspChannels', ((await rln('/listchannels')).channels as any[]).map(c => ({ id: c.channel_id.slice(0, 12), peer: c.peer_pubkey.slice(0, 10), public: c.public, usable: c.is_usable, local: c.asset_local_amount, remote: c.asset_remote_amount })))
await closeNode(alice); await closeNode(bob)
process.exit(0)
