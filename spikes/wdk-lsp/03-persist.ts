// B: does the VLS signer state survive a process restart, and do channels stay usable?
//   node 03-persist.ts setup    open alice + bob, fund, BTC channel alice -> bob, pay once both ways
//   node 03-persist.ts check    (new process) unlock again, list channels, pay both ways again
// Set KITTY_PERMISSIVE=1 to use the permissive signer policy (regtest diagnostic only).
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, log, errMsg, openNode, closeNode, fundNode, mine, waitFor, usableChannel, payAndWait, saveState, loadState, PEER_PORT, sleep } from './lib.ts'

const phase = process.argv[2] ?? 'setup'
const policy = process.env.KITTY_PERMISSIVE === '1' ? 'permissive' : 'strict'
const alice = await openNode('alice')
const bob = await openNode('bob')
log(`B.${phase}.unlocked`, { policy, alice: alice.pubkey, bob: bob.pubkey, signerDirs: ['alice', 'bob'].map(n => existsSync(join(HERE, 'data', n, 'ln', 'vls-signer')) ? readdirSync(join(HERE, 'data', n, 'ln', 'vls-signer')) : null) })
await alice.account.connectPeer(`${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`).catch((e: unknown) => log('B.connect.error', errMsg(e)))

async function payBoth (tag: string) {
  const inv1 = await bob.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600 })
  log(`B.${tag}.pay.alice->bob`, await payAndWait(alice, inv1.invoice))
  const inv2 = await alice.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600 })
  log(`B.${tag}.pay.bob->alice`, await payAndWait(bob, inv2.invoice))
}

try {
  if (phase === 'setup') {
    await fundNode(alice); await fundNode(bob)
    log('B.setup.balances', { alice: await alice.account.getBalance(), bob: await bob.account.getBalance() })
    const r = await alice.account.openChannel({ peer_pubkey_and_opt_addr: `${bob.pubkey}@127.0.0.1:${PEER_PORT.bob}`, capacity_sat: 1_000_000, push_msat: 200_000_000, public: false, with_anchors: true })
    log('B.setup.openChannel', r)
    await sleep(3000); mine(6)
    const ch = await waitFor('usable', async () => { await alice.account.sync(); await bob.account.sync(); return usableChannel(alice, bob.pubkey) }, 90000, 1000)
    log('B.setup.usable', { channel_id: ch.channel_id, outbound_msat: ch.outbound_balance_msat, inbound_msat: ch.inbound_balance_msat })
    saveState({ btcChannel: ch.channel_id })
    await payBoth('setup')
  } else {
    const chans: any[] = await alice.account.listChannels()
    log('B.check.channels', chans.map(c => ({ id: c.channel_id, usable: c.is_usable, ready: c.ready, out: c.outbound_balance_msat })))
    await waitFor('usable after restart', () => usableChannel(alice, bob.pubkey), 60000, 1000).catch(e => log('B.check.notUsable', errMsg(e)))
    await payBoth('check')
    log('B.check.channelsAfter', ((await alice.account.listChannels()) as any[]).map(c => ({ id: c.channel_id, usable: c.is_usable, out: c.outbound_balance_msat })))
  }
} catch (e) { log(`B.${phase}.error`, errMsg(e)) }
await closeNode(alice); await closeNode(bob)
log(`B.${phase}.shutdown`, 'ok')
process.exit(0)
