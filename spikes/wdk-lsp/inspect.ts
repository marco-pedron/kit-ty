// Read-only: unlock the given nodes and print channels and payments. Usage: node inspect.ts alice bob
import { log, openNode, closeNode, type Name } from './lib.ts'
for (const name of process.argv.slice(2) as Name[]) {
  const n = await openNode(name)
  await new Promise(r => setTimeout(r, 4000))
  const ch: any[] = await n.account.listChannels()
  const pays: any[] = await n.account.listPayments()
  log(`inspect.${name}`, {
    pubkey: n.pubkey,
    channels: ch.map(c => ({ id: c.channel_id.slice(0, 12), peer: c.peer_pubkey.slice(0, 10), usable: c.is_usable, ready: c.ready, out: c.outbound_balance_msat, asset: c.asset_id?.slice(0, 14), local: c.asset_local_amount, remote: c.asset_remote_amount })),
    payments: pays.slice(-6).map(p => ({ hash: p.payment_hash.slice(0, 10), status: p.status, inbound: p.inbound, asset: p.asset_amount }))
  })
  await closeNode(n)
}
process.exit(0)
