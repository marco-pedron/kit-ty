// E (setup): bring the Utexo LSP up on regtest: init + unlock its RLN node (v0.13.0-beta.3),
// fund it with BTC and DUSD (from the spike treasury), set SUPPORTED_ASSET_IDS, start utexo-lsp.
// Usage: node 06-lsp-up.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { HERE, log, errMsg, rln, fund, mine, sleep, waitFor, loadState, saveState, LSP_API, BITCOIND } from './lib.ts'

const SECRET = join(HERE, '.secrets-lsp')
const unlockBody = (password: string) => ({
  password,
  ldk_chain_sync: { mode: 'BlockSync', config: { bitcoind_rpc_username: BITCOIND.user, bitcoind_rpc_password: BITCOIND.pass, bitcoind_rpc_host: '127.0.0.1', bitcoind_rpc_port: BITCOIND.port } },
  indexer_url: '127.0.0.1:50101',
  proxy_endpoint: 'rpc://127.0.0.1:3100/json-rpc',
  announce_addresses: [],
  announce_alias: 'spike-lsp'
})
let sec: any = existsSync(SECRET) ? JSON.parse(readFileSync(SECRET, 'utf8')) : null
if (!sec) {
  const password = randomBytes(12).toString('hex')
  const r = await rln('/init', { password })
  sec = { password, mnemonic: r.mnemonic }
  writeFileSync(SECRET, JSON.stringify(sec), { mode: 0o600 })
  log('E.lsp.init', 'ok')
}
try { await rln('/unlock', unlockBody(sec.password)); log('E.lsp.unlock', 'ok') } catch (e) { log('E.lsp.unlock', errMsg(e)) }
const info = await rln('/nodeinfo')
log('E.lsp.nodeinfo', { pubkey: info.pubkey, channels: info.num_channels })
saveState({ lspPubkey: info.pubkey })

const assetId = loadState().assetId
const bal = await rln('/btcbalance', { skip_sync: false })
if ((bal.vanilla?.spendable ?? 0) < 1_000_000) {
  const { address } = await rln('/address', {})
  fund(address, 5); mine(1); await sleep(2000)
  await rln('/createutxos', { up_to: false, num: 8, size: 1_100_000, fee_rate: 2, skip_sync: false })
  mine(1); await sleep(2000)
  log('E.lsp.funded', await rln('/btcbalance', { skip_sync: false }))
}
await rln('/refreshtransfers', { asset_id: null, filter: [], skip_sync: false }).catch(() => null)
const ab = await rln('/assetbalance', { asset_id: assetId }).catch(() => ({ settled: 0 }))
if (!(ab.settled >= 40000)) {
  const missing = ab.settled >= 20000 ? [20000] : [20000, 20000]
  // two separate allocations so the LSP can open two asset channels at once (spike 2, trap 6)
  for (const amount of missing) {
    const inv = await rln('/rgbinvoice', { min_confirmations: 1, witness: false, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600, transport_endpoints: ['rpc://127.0.0.1:3100/json-rpc'] })
    const out = execFileSync('node', [join(HERE, '04-issue.ts'), 'sendraw', inv.invoice, String(amount)], { encoding: 'utf8' })
    log('E.lsp.onramp', { amount, out: out.trim().split('\n').pop()?.slice(0, 200) })
    await waitFor('lsp asset settled', async () => {
      await rln('/refreshtransfers', { asset_id: null, filter: [], skip_sync: false }); mine(1)
      const b = await rln('/assetbalance', { asset_id: assetId }).catch(() => null)
      return b && b.settled >= ab.settled + amount ? b : undefined
    }, 90000, 2000).catch(e => log('E.lsp.onramp.error', errMsg(e)))
  }
}
log('E.lsp.assetbalance', await rln('/assetbalance', { asset_id: assetId }).catch(e => errMsg(e)))

const envPath = join(HERE, '.env.lsp')
writeFileSync(envPath, readFileSync(envPath, 'utf8').replace(/^SUPPORTED_ASSET_IDS=.*$/m, `SUPPORTED_ASSET_IDS=${assetId}`))
execFileSync('docker', ['compose', '-f', join(HERE, 'docker/compose.yaml'), '--profile', 'lsp', 'up', '-d', '--force-recreate', 'lsp'], { stdio: 'inherit' })
const getInfo = await waitFor('lsp get_info', async () => {
  const r = await fetch(LSP_API + '/get_info').catch(() => null)
  return r && r.ok ? r.json() : undefined
}, 30000, 1000).catch(e => errMsg(e))
log('E.lsp.get_info', getInfo)
process.exit(0)
