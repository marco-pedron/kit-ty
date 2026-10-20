// Shared helpers for spike 3 (WDK + LSP). Regtest only, isolated stack in docker/compose.yaml.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateMnemonic } from 'bip39'
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const NAMES = ['alice', 'bob', 'charlie', 'dave'] as const
export type Name = (typeof NAMES)[number]
export const PEER_PORT: Record<Name, number> = { alice: 9935, bob: 9936, charlie: 9937, dave: 9938 }

export const BITCOIND = { host: '127.0.0.1', port: 28443, user: 'user', pass: 'password' }
export const INDEXER = 'tcp://127.0.0.1:50101'
export const PROXY = 'rpc://127.0.0.1:3100/json-rpc'
export const LSP_API = 'http://127.0.0.1:29380'
export const LSP_RLN = 'http://127.0.0.1:29301'
export const LSP_P2P = '127.0.0.1:29735'

const SECRETS = join(HERE, '.secrets')
const STATE = join(HERE, 'data', 'state.json')

// Test mnemonics generated for this spike, gitignored, never reused anywhere else.
export function secrets (): Record<string, string> {
  if (!existsSync(SECRETS)) {
    const s: Record<string, string> = {}
    for (const n of NAMES) s[n] = generateMnemonic(128)
    writeFileSync(SECRETS, JSON.stringify(s, null, 2), { mode: 0o600 })
  }
  return JSON.parse(readFileSync(SECRETS, 'utf8'))
}

export function loadState (): Record<string, any> {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
}
export function saveState (patch: Record<string, any>) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2))
}

const json = (data: unknown) => JSON.stringify(data, (_k, v) => typeof v === 'bigint' ? v.toString() : v)
export function log (step: string, data: unknown) {
  const line = `[${new Date().toISOString()}] ${step} ${json(data)}`
  console.log(line)
  appendFileSync(join(HERE, 'calls.log'), line + '\n')
}
export const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 600)

const BCLI = ['exec', '-u', 'blits', 'kitty-lsp-bitcoind-1', 'bitcoin-cli', '-regtest']
export function bcli (...args: string[]): string {
  return execFileSync('docker', [...BCLI, ...args], { encoding: 'utf8' }).trim()
}
let minerLoaded = false
function ensureMiner () {
  if (minerLoaded) return
  const wallets = bcli('listwallets')
  if (!wallets.includes('"miner"')) {
    try { bcli('loadwallet', 'miner') } catch { bcli('createwallet', 'miner') }
  }
  minerLoaded = true
}
export function mine (n: number): number {
  ensureMiner()
  bcli('-rpcwallet=miner', '-generate', String(n))
  return Number(bcli('getblockcount'))
}
export function fund (address: string, btc: number): string {
  ensureMiner()
  return bcli('-rpcwallet=miner', 'sendtoaddress', address, String(btc))
}

export const UNLOCK = (alias: string) => ({
  ldk_chain_sync: {
    mode: 'BlockSync',
    config: {
      bitcoind_rpc_username: BITCOIND.user,
      bitcoind_rpc_password: BITCOIND.pass,
      bitcoind_rpc_host: BITCOIND.host,
      bitcoind_rpc_port: BITCOIND.port
    }
  },
  indexer_url: INDEXER,
  proxy_endpoint: PROXY,
  announce_addresses: [],
  announce_alias: alias
})

export type Node = { name: Name, manager: any, account: any, pubkey: string }

export type NodeOpts = { dataDir?: string, vssUrl?: string, extra?: Record<string, unknown>, mnemonic?: string }

export function nodeConfig (name: Name, opts: NodeOpts = {}) {
  const dataDir = opts.dataDir ?? join(HERE, 'data', name, 'ln')
  mkdirSync(dataDir, { recursive: true })
  const cfg: any = { network: 'regtest', dataDir, ldkPeerListeningPort: PEER_PORT[name] }
  if (opts.vssUrl) { cfg.vssUrl = opts.vssUrl; cfg.vssAllowHttp = true }
  // Regtest diagnostic: the strict VLS policy stalls outbound payments in Utexo's own
  // qualification (tests/regtest/QUALIFICATION.md, blocker 1). Off unless KITTY_PERMISSIVE=1.
  if (process.env.KITTY_PERMISSIVE === '1') cfg.permissiveSignerPolicy = true
  Object.assign(cfg, opts.extra)
  return cfg
}

export async function openNode (name: Name, opts: NodeOpts = {}): Promise<Node> {
  const manager = new WalletManagerRgbLightning(opts.mnemonic ?? secrets()[name], nodeConfig(name, opts))
  const account = await manager.getAccount(0)
  await account.unlock(UNLOCK(name))
  const info = await account.getNodeInfo()
  return { name, manager, account, pubkey: info.pubkey }
}

export async function closeNode (n: Node) {
  try { await n.account.shutdown() } catch (e) { log('shutdown.error', { name: n.name, e: errMsg(e) }) }
  try { n.manager.dispose() } catch {}
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function waitFor<T> (what: string, fn: () => Promise<T | undefined | false | null>, timeoutMs = 60000, everyMs = 500): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`)
    await sleep(everyMs)
  }
}

// RLN REST (the LSP node). Only endpoints from the node's own openapi.yaml.
export async function rln (path: string, body?: unknown, base = LSP_RLN): Promise<any> {
  const res = await fetch(base + path, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let data: any = text
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 400)}`)
  return data
}

// Give a node BTC and colored UTXOs big enough to fund channels (spike 2, trap 5).
export async function fundNode (n: Node, btc = 3, utxos = 3, size = 1_100_000) {
  const addr = await n.account.getAddress()
  fund(typeof addr === 'string' ? addr : addr.address, btc)
  mine(1)
  await n.account.sync()
  try {
    await n.account.createUtxos({ up_to: false, num: utxos, size, fee_rate: 2, skip_sync: false })
  } catch (e) { log('fund.createUtxos.error', { name: n.name, e: errMsg(e) }) }
  mine(1)
  await n.account.sync()
}

export async function usableChannel (n: Node, peer: string) {
  const chans: any[] = await n.account.listChannels()
  return chans.find(c => c.peer_pubkey === peer && c.is_usable)
}

export async function payAndWait (payer: Node, invoice: string, timeoutMs = 30000) {
  const t0 = Date.now()
  const sent = await payer.account.sendPayment({ invoice })
  const hash = sent.payment_hash
  let p: any
  try {
    p = await waitFor('payment', async () => {
      const x = await payer.account.getPayment(hash, 'Outbound')
      return ['Succeeded', 'Failed', 'Cancelled'].includes(x?.status) ? x : undefined
    }, timeoutMs, 250)
  } catch (e) {
    p = await payer.account.getPayment(hash, 'Outbound').catch(() => null)
    return { status: p?.status ?? 'timeout', hash, ms: Date.now() - t0, timeout: true }
  }
  return { status: p.status, hash, preimage: p.preimage, ms: Date.now() - t0, payee: p.payee_pubkey }
}
