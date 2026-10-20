// D: VSS backup, wallet deleted, restore from seed + VSS: do balances and channels come back?
//   node 09-vss.ts backup    charlie (fresh, VSS on): fund, get DUSD, open DUSD channel to the LSP,
//                            pay the LSP once, vssBackup(), record state, shut down
//   node 09-vss.ts restore   move charlie's dataDir away ("phone lost"), new empty dataDir, same
//                            seed + vssUrl; unlock in a child process with a hard 5-minute timeout
//   node 09-vss.ts _restore  (child) the actual restore + checks
// KITTY_PERMISSIVE=1 required (see B).
import { execFileSync, spawnSync } from 'node:child_process'
import { renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, log, errMsg, openNode, closeNode, fundNode, mine, sleep, waitFor, loadState, saveState, rln, payAndWait } from './lib.ts'

const VSS = 'http://127.0.0.1:8091/vss'
const phase = process.argv[2]
const { assetId, lspPubkey } = loadState()
const NODE = (process.env.KITTY_VSS_NODE ?? 'charlie') as 'charlie' | 'dave'
const dataDir = join(HERE, 'data', NODE, 'ln')
const snapshot = async (n: any) => {
  await n.account.refreshTransfers({ skip_sync: false }).catch(() => null)
  return {
    pubkey: n.pubkey,
    btc: await n.account.getBalance().catch((e: unknown) => errMsg(e)),
    dusd: await n.account.getAssetBalance(assetId).catch((e: unknown) => errMsg(e)),
    channels: ((await n.account.listChannels()) as any[]).map(c => ({ id: c.channel_id.slice(0, 12), usable: c.is_usable, local: c.asset_local_amount, remote: c.asset_remote_amount, outMsat: c.outbound_balance_msat }))
  }
}

if (phase === 'backup') {
  const c = await openNode(NODE, { vssUrl: VSS })
  log('D.backup.vssStatus.start', await c.account.vssStatus())
  const has = async () => { await c.account.refreshTransfers({ skip_sync: false }).catch(() => null); return c.account.getAssetBalance(assetId).catch(() => null) }
  const b0: any = await has()
  if (!b0 || (b0.settled < 5000 && b0.future < 5000)) {
    await fundNode(c)
    const inv = await c.account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
    execFileSync('node', [join(HERE, '04-issue.ts'), 'sendraw', inv.invoice, '5000'], { stdio: 'ignore' })
  }
  // blinded transfer: recipient ACK -> sender refresh broadcasts -> 1 block -> both refresh
  await waitFor('charlie dusd', async () => {
    const b: any = await has()
    execFileSync('node', [join(HERE, '04-issue.ts'), 'refresh'], { stdio: 'ignore' })
    return b?.settled >= 5000 ? b : undefined
  }, 120000, 1000)
  await c.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`); await sleep(1500)
  await c.account.openChannel({ peer_pubkey_and_opt_addr: `${lspPubkey}@127.0.0.1:29735`, capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, asset_amount: 3000, public: false, with_anchors: true })
  await sleep(4000); mine(6)
  await waitFor('charlie channel usable', async () => { await c.account.sync(); mine(1); return ((await c.account.listChannels()) as any[]).some(x => x.is_usable && x.asset_id) }, 120000, 2000)
  const lspInv = await rln('/lninvoice', { amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 250 })
  log('D.backup.pay250', await payAndWait(c, lspInv.invoice))
  const t0 = Date.now()
  const v = await c.account.vssBackup()
  log('D.backup.vssBackup', { ...v, ms: Date.now() - t0 })
  const snap = await snapshot(c)
  saveState({ [`vssSnapshot_${NODE}`]: snap })
  log('D.backup.snapshot', snap)
  await closeNode(c)
} else if (phase === 'snap') {
  // resume after an interrupted backup run: check the pending payment, back up again, snapshot
  const c = await openNode(NODE, { vssUrl: VSS })
  await c.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
  await sleep(8000)
  const pays = ((await c.account.listPayments()) as any[]).map(p => ({ hash: p.payment_hash.slice(0, 10), status: p.status, inbound: p.inbound, asset: p.asset_amount }))
  log('D.snap.payments', pays)
  const lspInv = await rln('/lninvoice', { amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 250 })
  log('D.snap.pay250', await payAndWait(c, lspInv.invoice))
  const t0 = Date.now()
  log('D.snap.vssBackup', { ...(await c.account.vssBackup()), ms: Date.now() - t0 })
  const snap = await snapshot(c)
  saveState({ [`vssSnapshot_${NODE}`]: snap })
  log('D.snap.snapshot', snap)
  await closeNode(c)
} else if (phase === 'restore') {
  const lost = join(HERE, 'data', `${NODE}-lost-${Date.now()}`)
  renameSync(join(HERE, 'data', NODE), lost)
  log(`D.restore.${NODE}.phoneLost`, { movedTo: lost.split('/').pop() })
  const r = spawnSync('node', [join(HERE, '09-vss.ts'), '_restore'], { env: process.env, encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' })
  process.stdout.write(r.stdout ?? '')
  if (r.error || r.signal) log(`D.restore.${NODE}.child`, { killed: r.signal, error: r.error ? errMsg(r.error) : null, note: 'restore did not finish within 5 minutes' })
  log(`D.restore.${NODE}.newDataDir`, existsSync(dataDir) ? readdirSync(dataDir) : null)
} else if (phase === '_restore') {
  const t0 = Date.now()
  try {
    const c = await openNode(NODE, { vssUrl: VSS })
    log(`D.restore.${NODE}.unlocked`, { secs: Math.round((Date.now() - t0) / 1000) })
    await c.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
    await sleep(5000); await c.account.sync()
    const snap = await snapshot(c)
    const before = loadState()[`vssSnapshot_${NODE}`]
    log(`D.restore.${NODE}.snapshot`, { snap, samePubkey: snap.pubkey === before.pubkey, sameDusd: JSON.stringify(snap.dusd) === JSON.stringify(before.dusd), sameChannels: JSON.stringify([...snap.channels].sort((a: any, b: any) => a.id.localeCompare(b.id))) === JSON.stringify([...before.channels].sort((a: any, b: any) => a.id.localeCompare(b.id))) })
    const lspInv = await rln('/lninvoice', { amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: 100 })
    log(`D.restore.${NODE}.payAfterRestore`, await payAndWait(c, lspInv.invoice))
    await closeNode(c)
  } catch (e) { log(`D.restore.${NODE}.error`, { secs: Math.round((Date.now() - t0) / 1000), e: errMsg(e) }) }
  process.exit(0)
}
process.exit(0)
