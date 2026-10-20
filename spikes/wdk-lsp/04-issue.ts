// Issue DUSD (NIA, precision 2) with wdk-wallet-rgb 2.0.3 and send it to WDK Lightning nodes.
// wdk-wallet-rgb is imported read-only from infra/treasury/node_modules: its rgb-lib binary
// does not compile here any more (macOS 27 SDK linker error), and it must not be reinstalled.
//   node 04-issue.ts issue                 issue 1,000,000 units to the spike treasury
//   node 04-issue.ts send <name> <units>   send units to a member's WDK node (blinded invoice)
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateMnemonic } from 'bip39'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { HERE, log, errMsg, openNode, closeNode, fund, mine, waitFor, sleep, saveState, loadState, INDEXER, PROXY, type Name } from './lib.ts'

const { default: WalletManagerRgb } = await import(join(HERE, '../../infra/treasury/node_modules/@utexo/wdk-wallet-rgb/index.js'))
const TSECRET = join(HERE, '.secrets-treasury')
if (!existsSync(TSECRET)) writeFileSync(TSECRET, generateMnemonic(128), { mode: 0o600 })
const dataDir = join(HERE, 'data', 'treasury'); mkdirSync(dataDir, { recursive: true })
const manager = new WalletManagerRgb(readFileSync(TSECRET, 'utf8').trim(), { network: 'regtest', indexerUrl: INDEXER, transportEndpoint: PROXY, dataDir })
const t = await manager.getAccount()

const [cmd, who, units] = process.argv.slice(2)
try {
  if (cmd === 'issue') {
    const addr = await t.getAddress()
    fund(addr, 1); mine(1); await sleep(1500)
    await t.createUtxos({ upTo: false, num: 8, size: 32_000, feeRate: 2 })
    mine(1); await sleep(1500)
    const asset = t.issueAssetNia({ ticker: 'DUSD', name: 'Demo Dollar', precision: 2, amounts: [1_000_000] })
    log('C.issue', { assetId: asset.assetId ?? asset.asset_id, raw: asset })
    saveState({ assetId: asset.assetId ?? asset.asset_id })
  } else if (cmd === 'sendraw') {
    // send to an RGB invoice made elsewhere (the LSP node): node 04-issue.ts sendraw <invoice> <units>
    const res = await t.transfer({ recipient: who, token: loadState().assetId, amount: Number(units), feeRate: 2, minConfirmations: 1 })
    await sleep(1500); t.refreshWallet(); mine(1); await sleep(1500); t.refreshWallet()
    log('C.sendraw.transfer', { txid: res.hash })
  } else if (cmd === 'send') {
    const assetId = loadState().assetId
    const n = await openNode(who as Name)
    const inv = await n.account.createRgbInvoice({ min_confirmations: 1, witness: false, duration_seconds: 3600 })
    log('C.send.invoice', { to: who, invoice: inv.invoice?.slice(0, 60) })
    const res = await t.transfer({ recipient: inv.invoice, token: assetId, amount: Number(units), feeRate: 2, minConfirmations: 1 })
    log('C.send.transfer', { txid: res.hash })
    await sleep(1000)
    const bal = await waitFor('settled', async () => {
      await n.account.refreshTransfers({ skip_sync: false }).catch(() => null)
      t.refreshWallet()
      mine(1)
      const b = await n.account.getAssetBalance(assetId).catch((e: unknown) => ({ err: errMsg(e) }))
      return (b as any).settled >= Number(units) ? b : undefined
    }, 90000, 2000).catch(async e => ({ timeout: errMsg(e), b: await n.account.getAssetBalance(assetId).catch((x: unknown) => errMsg(x)) }))
    log('C.send.balance', { to: who, bal })
    await closeNode(n)
  }
} catch (e) { log(`C.${cmd}.error`, errMsg(e)) }
try { manager.dispose() } catch {}
process.exit(0)
