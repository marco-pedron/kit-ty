// D (follow-up): do payments stall when VSS is on? charlie (VSS) <-> alice (no VSS), via the LSP,
// three payments each way in one session, 40 s timeout each. Usage: node 09c-vss-payments.ts
import { log, openNode, closeNode, sleep, loadState, payAndWait } from './lib.ts'
const { assetId, lspPubkey } = loadState()
const charlie = await openNode('charlie', { vssUrl: 'http://127.0.0.1:8091/vss' })
const alice = await openNode('alice')
for (const n of [charlie, alice]) await n.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
await sleep(8000)
for (let i = 0; i < 3; i++) {
  for (const [from, to] of [[charlie, alice], [alice, charlie]] as const) {
    const inv = await to.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 10 })
    const r = await payAndWait(from, inv.invoice, 40000)
    log(`D.vssPay.${i}.${from.name}->${to.name}`, { status: r.status, ms: r.ms })
  }
}
await closeNode(charlie); await closeNode(alice)
process.exit(0)
