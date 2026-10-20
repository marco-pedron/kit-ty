// E/F workaround, step 2: cooperatively close the LSP's public (never announced) channels, which
// make LDK drop every route hint from the member's invoices. Also stops utexo-lsp so its cron
// does not reopen them (it opens a channel for any connected peer missing one).
// Usage: node 07c-close-public.ts
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { HERE, log, errMsg, openNode, closeNode, mine, sleep, rln, loadState } from './lib.ts'
const { lspPubkey } = loadState()
execFileSync('docker', ['compose', '-f', join(HERE, 'docker/compose.yaml'), '--profile', 'lsp', 'stop', 'lsp'], { stdio: 'inherit' })
log('E.lsp.cronStopped', 'utexo-lsp stopped; LSP node keeps running')
const alice = await openNode('alice'); const bob = await openNode('bob')
for (const n of [alice, bob]) await n.account.connectPeer(`${lspPubkey}@127.0.0.1:29735`).catch(() => null)
await sleep(3000)
const pub = ((await rln('/listchannels')).channels as any[]).filter(c => c.public)
for (const c of pub) {
  try { log('E.closePublic', { id: c.channel_id.slice(0, 12), r: await rln('/closechannel', { channel_id: c.channel_id, peer_pubkey: c.peer_pubkey, force: false }) }) } catch (e) { log('E.closePublic.error', errMsg(e)) }
}
for (let i = 0; i < 16; i++) { await sleep(1500); mine(1) }
await alice.account.sync(); await bob.account.sync()
log('E.closePublic.after', ((await rln('/listchannels')).channels as any[]).map(c => ({ id: c.channel_id.slice(0, 12), peer: c.peer_pubkey.slice(0, 10), public: c.public, usable: c.is_usable, local: c.asset_local_amount, remote: c.asset_remote_amount })))
await closeNode(alice); await closeNode(bob)
process.exit(0)
