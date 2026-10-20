// D (control): fresh node dave WITH VSS, utexo-lsp cron stopped (no public channel). Opens a DUSD
// channel to the LSP node, then pays the LSP node 3 times and alice (no VSS) once.
// Usage: KITTY_VSS=1 node 09d-vss-fresh.ts   (KITTY_VSS=0 runs the same with VSS off, as control)
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { HERE, log, errMsg, openNode, closeNode, fundNode, mine, sleep, waitFor, loadState, rln, payAndWait } from './lib.ts'
const { assetId, lspPubkey } = loadState()
const vss = process.env.KITTY_VSS !== '0'
execFileSync('docker', ['compose', '-f', join(HERE, 'docker/compose.yaml'), '--profile', 'lsp', 'stop', 'lsp'], { stdio: 'ignore' })
const d = await openNode('dave', vss ? { vssUrl: 'http://127.0.0.1:8091/vss' } : {})
try {
  const has = async () => { await d.account.refreshTransfers({ skip_sync: false }).catch(() => null); return d.account.getAssetBalance(assetId).catch(() => null) }
  const b0: any = await has()
  if (!b0 || b0.settled + (b0.offchain_outbound ?? 0) < 3000) {
    await fundNode(d)
    const inv = await d.account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
    execFileSync('node', [join(HERE, '04-issue.ts'), 'sendraw', inv.invoice, '5000'], { stdio: 'ignore' })
    await waitFor('dave dusd', async () => { const b: any = await has(); execFileSync('node', [join(HERE, '04-issue.ts'), 'refresh'], { stdio: 'ignore' }); return b?.settled >= 5000 ? b : undefined }, 120000, 1000)
  }
  await d.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`); await sleep(2000)
  if (!((await d.account.listChannels()) as any[]).some(c => c.asset_id && c.peer_pubkey === lspPubkey)) {
    await d.account.openChannel({ peer_pubkey_and_opt_addr: `${lspPubkey}@127.0.0.1:29735`, capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, asset_amount: 3000, public: false, with_anchors: true })
    await sleep(4000); mine(6)
  }
  await waitFor('dave channel usable', async () => { await d.account.sync(); mine(1); return ((await d.account.listChannels()) as any[]).some(x => x.is_usable && x.asset_id) }, 120000, 2000)
  for (let i = 0; i < 3; i++) {
    const inv = await rln('/lninvoice', { amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 10 })
    const r = await payAndWait(d, inv.invoice, 40000)
    log(`D.fresh.${vss ? 'vss' : 'novss'}.payLsp.${i}`, { status: r.status, ms: r.ms })
  }
  if (vss) log('D.fresh.vssBackup', await d.account.vssBackup())
} catch (e) { log('D.fresh.error', errMsg(e)) }
await closeNode(d)
process.exit(0)
