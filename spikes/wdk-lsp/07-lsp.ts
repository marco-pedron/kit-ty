// E + F: WDK members against the Utexo LSP on regtest.
//   node 07-lsp.ts channels   alice and bob connect; the LSP cron opens its liquidity channel to
//                             each (F: standard, on-chain anchored?); each member opens its own
//                             DUSD channel to the LSP (the "trip channel")
//   node 07-lsp.ts pay        routed payment alice -> LSP -> bob in DUSD (bob's invoice)
//   node 07-lsp.ts bridges    UtexoLsp.receiveAsset (on-chain -> LN) and sendAsset (LN -> on-chain)
// Use KITTY_PERMISSIVE=1 (strict signer cannot fund channels, see B).
import { log, errMsg, openNode, closeNode, mine, waitFor, payAndWait, sleep, loadState, saveState, bcli, rln, LSP_API, type Node } from './lib.ts'

const phase = process.argv[2]
const { assetId, lspPubkey } = loadState()
const lspPeer = { baseUrl: LSP_API, peerPubkey: lspPubkey, peerHost: '127.0.0.1', peerPort: 29735, allowHttp: true, bearerToken: 'spike-local-apay-only', network: 'regtest' }
const extra = { lspBaseUrl: LSP_API, lspBearerToken: 'spike-local-apay-only' }
const alice = await openNode('alice', { extra })
const bob = await openNode('bob', { extra })
const lspA = await alice.account.createLsp(lspPeer)
const lspB = await bob.account.createLsp(lspPeer)
await lspA.connect(); await lspB.connect()
await sleep(2000)

const chans = async (n: Node) => ((await n.account.listChannels()) as any[]).filter(c => c.peer_pubkey === lspPubkey)
const summary = (cs: any[]) => cs.map(c => ({ id: c.channel_id.slice(0, 12), funding: c.funding_txid, usable: c.is_usable, asset: c.asset_id ? 'DUSD' : null, local: c.asset_local_amount, remote: c.asset_remote_amount, outMsat: c.outbound_balance_msat, inMsat: c.inbound_balance_msat, public: c.public }))
const bal = async (n: Node) => { await n.account.refreshTransfers({ skip_sync: false }).catch(() => null); return n.account.getAssetBalance(assetId).catch((e: unknown) => errMsg(e)) }

try {
  if (phase === 'channels') {
    for (const [n, lsp] of [[alice, lspA], [bob, lspB]] as const) {
      const t0 = Date.now()
      const ready = await lsp.waitForChannel(assetId, { timeoutMs: 120000, pollIntervalMs: 2000, onEachPoll: async () => { mine(1) } }).catch((e: unknown) => ({ error: errMsg(e) }))
      log(`F.${n.name}.lspChannel`, { secs: Math.round((Date.now() - t0) / 1000), ready })
    }
    for (const n of [alice, bob]) {
      const cs = await chans(n)
      for (const c of cs) {
        let onchain: any = null
        try { const tx = JSON.parse(bcli('getrawtransaction', c.funding_txid, 'true')); onchain = { confirmations: tx.confirmations ?? 0, vout: tx.vout.length } } catch (e) { onchain = errMsg(e) }
        log(`F.${n.name}.fundingOnChain`, { channel: c.channel_id.slice(0, 12), funding: c.funding_txid, onchain })
      }
    }
    // member's own DUSD channel to the LSP (spends the member's DUSD)
    for (const [n, amount] of [[alice, 5000], [bob, 3000]] as const) {
      try {
        const r = await n.account.openChannel({ peer_pubkey_and_opt_addr: `${lspPubkey}@127.0.0.1:29735`, capacity_sat: 1_000_000, push_msat: 0, asset_id: assetId, asset_amount: amount, public: false, with_anchors: true })
        log(`F.${n.name}.ownChannel.open`, r)
      } catch (e) { log(`F.${n.name}.ownChannel.open.error`, errMsg(e)) }
    }
    await sleep(3000); mine(6)
    await waitFor('own channels usable', async () => {
      await alice.account.sync(); await bob.account.sync()
      const a = (await chans(alice)).filter(c => c.is_usable && c.asset_id).length
      const b = (await chans(bob)).filter(c => c.is_usable && c.asset_id).length
      return a >= 2 && b >= 2
    }, 120000, 2000).catch(e => log('F.ownChannel.wait', errMsg(e)))
    log('F.alice.channels', summary(await chans(alice)))
    log('F.bob.channels', summary(await chans(bob)))
    log('F.lsp.channels', ((await rln('/listchannels')).channels as any[]).map(c => ({ id: c.channel_id.slice(0, 12), peer: c.peer_pubkey.slice(0, 10), usable: c.is_usable, local: c.asset_local_amount, remote: c.asset_remote_amount })))
  } else if (phase === 'pay') {
    await waitFor('all LSP channels usable', async () => { await alice.account.sync(); await bob.account.sync(); return (await chans(alice)).every(c => c.is_usable) && (await chans(bob)).every(c => c.is_usable) }, 60000, 1500).catch(e => log('E.pay.notUsable', errMsg(e)))
    log('E.pay.channelsBefore', { alice: summary(await chans(alice)), bob: summary(await chans(bob)) })
    for (const [from, to, amt] of [[alice, bob, 309], [bob, alice, 350]] as const) {
      const inv = await to.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: amt })
      const dec = await from.account.decodeInvoice(inv.invoice)
      const res = await payAndWait(from, inv.invoice, 40000)
      const { createHash } = await import('node:crypto')
      log(`E.pay.${from.name}->${to.name}`, {
        amount: amt, ...res,
        payeeIsRecipient: dec.payee_pubkey === to.pubkey,
        hashMatches: res.preimage ? createHash('sha256').update(Buffer.from(res.preimage, 'hex')).digest('hex') === dec.payment_hash : null,
        directUsableChannel: ((await from.account.listChannels()) as any[]).some(c => c.peer_pubkey === to.pubkey && c.is_usable)
      })
    }
    log('E.pay.channelsAfter', { alice: summary(await chans(alice)), bob: summary(await chans(bob)) })
  } else if (phase === 'bridges') {
    // E1: on-chain -> LN. bob mints an LN invoice; the LSP gives an RGB invoice; alice pays it on-chain.
    try {
      const r = await lspB.receiveAsset({ assetId, amountRgb: 100, amountSats: 3000 })
      log('E.bridge.receiveAsset', { rgbInvoice: r.rgbInvoice.slice(0, 50), payee: (await bob.account.decodeInvoice(r.lnInvoice)).payee_pubkey === bob.pubkey })
      const d = await alice.account.decodeRgbInvoice(r.rgbInvoice)
      const sent = await alice.account.sendRgbAsset({ donation: false, fee_rate: 2, min_confirmations: 1, recipient_groups: [{ asset_id: assetId, recipients: [{ recipient_id: d.recipient_id, assignment_kind: 'Fungible', assignment_amount: 100, transport_endpoints: d.transport_endpoints }] }] }).catch((e: unknown) => ({ error: errMsg(e) }))
      for (let i = 0; i < 6; i++) { await sleep(2000); await alice.account.refreshTransfers({ skip_sync: false }).catch(() => null); mine(1) }
      log('E.bridge.receiveAsset.aliceSendRgb', sent)
      const st = await lspB.awaitReceiveSettlement(r.lnInvoice, { timeoutMs: 120000, pollIntervalMs: 3000 }).catch((e: unknown) => errMsg(e))
      log('E.bridge.receiveAsset.settled', { status: st })
    } catch (e) { log('E.bridge.receiveAsset.error', errMsg(e)) }
    // E2: LN -> on-chain. bob makes an on-chain RGB invoice; alice pays the LSP's LN invoice.
    try {
      const inv = await bob.account.createRgbInvoice({ min_confirmations: 1, witness: false, asset_id: assetId, assignment_kind: 'Fungible', assignment_amount: 100, duration_seconds: 3600 })
      const r = await lspA.sendAsset({ rgbInvoice: inv.invoice, ln: { amtMsat: 3_000_000, assetId, assetAmount: 100 } })
      const dec = await alice.account.decodeInvoice(r.lnInvoice)
      log('E.bridge.sendAsset', { payeeIsLsp: dec.payee_pubkey === lspPubkey, payeeIsBob: dec.payee_pubkey === bob.pubkey, send: r.sendResult })
      for (let i = 0; i < 10; i++) { await sleep(3000); mine(1) }
      log('E.bridge.sendAsset.bobBalance', await bal(bob))
    } catch (e) { log('E.bridge.sendAsset.error', errMsg(e)) }
  }
} catch (e) { log(`EF.${phase}.error`, errMsg(e)) }
await closeNode(alice); await closeNode(bob)
process.exit(0)
