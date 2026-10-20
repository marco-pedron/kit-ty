// G: alice pays bob through the LSP while bob's process is stopped.
//   node 08-async.ts invoice     bob online: create a 309 DUSD invoice, then exit (bob goes offline)
//   node 08-async.ts pay         alice only: pay it, watch status 60 s, inspect the LSP node's HTLCs
//   node 08-async.ts bobup       bob back online: does a held payment arrive? (only if still Pending)
//   node 08-async.ts retry       both online: pay a fresh invoice (the "retry when bob is back" path)
// KITTY_PERMISSIVE=1 required (see B).
import { log, errMsg, openNode, closeNode, sleep, loadState, saveState, rln, waitFor, payAndWait } from './lib.ts'
const phase = process.argv[2]
const { assetId, lspPubkey } = loadState()
const lspView = async () => {
  const ch = ((await rln('/listchannels')).channels as any[]).map(c => ({ id: c.channel_id.slice(0, 12), peer: c.peer_pubkey.slice(0, 10), usable: c.is_usable, local: c.asset_local_amount, remote: c.asset_remote_amount, outMsat: c.outbound_balance_msat }))
  const pays = ((await rln('/listpayments')).payments as any[]).slice(-3).map(p => ({ hash: p.payment_hash.slice(0, 10), status: p.status, inbound: p.inbound }))
  return { ch, pays }
}
try {
  if (phase === 'invoice') {
    const bob = await openNode('bob')
    await bob.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null); await sleep(2000)
    const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309 })
    saveState({ asyncInvoice: inv.invoice })
    log('G.invoice', { invoice: inv.invoice.slice(0, 40) })
    await closeNode(bob)
    log('G.bobOffline', 'bob process exits now')
  } else if (phase === 'pay') {
    const alice = await openNode('alice')
    await alice.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null); await sleep(3000)
    const t0 = Date.now()
    const sent = await alice.account.sendPayment({ invoice: loadState().asyncInvoice })
    log('G.pay.sent', { status: sent.status, hash: sent.payment_hash })
    saveState({ asyncHash: sent.payment_hash })
    let last: any
    for (let i = 0; i < 12; i++) {
      await sleep(5000)
      last = await alice.account.getPayment(sent.payment_hash, 'Outbound')
      if (i % 3 === 0 || last.status !== 'Pending') log('G.pay.poll', { secs: Math.round((Date.now() - t0) / 1000), status: last.status })
      if (last.status !== 'Pending') break
    }
    const ch = ((await alice.account.listChannels()) as any[]).filter(c => c.peer_pubkey === lspPubkey && c.asset_id).map(c => ({ id: c.channel_id.slice(0, 12), local: c.asset_local_amount, remote: c.asset_remote_amount }))
    log('G.pay.final', { status: last.status, aliceChannels: ch, lsp: await lspView() })
    await closeNode(alice)
  } else if (phase === 'bobup') {
    const bob = await openNode('bob')
    await bob.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
    await sleep(15000)
    const p = ((await bob.account.listPayments()) as any[]).find(x => x.payment_hash === loadState().asyncHash)
    log('G.bobup', { inboundPayment: p ? { status: p.status } : null, lsp: await lspView() })
    await closeNode(bob)
  } else if (phase === 'retry') {
    const alice = await openNode('alice'); const bob = await openNode('bob')
    for (const n of [alice, bob]) await n.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
    await sleep(3000)
    const inv = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 309 })
    log('G.retry', await payAndWait(alice, inv.invoice, 40000))
    await closeNode(alice); await closeNode(bob)
  }
} catch (e) { log(`G.${phase}.error`, errMsg(e)) }
process.exit(0)
