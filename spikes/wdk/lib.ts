// Shared helpers for the WDK spike. Regtest only.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateMnemonic } from 'bip39'
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const NAMES = ['alice', 'bob', 'charlie', 'dave'] as const
export type Name = (typeof NAMES)[number]
export const PEER_PORT: Record<Name, number> = { alice: 9835, bob: 9836, charlie: 9837, dave: 9838 }

const SECRETS = join(HERE, '.secrets')
const STATE = join(HERE, 'data', 'state.json')

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
  writeFileSync(STATE, JSON.stringify({ ...loadState(), ...patch }, null, 2))
}

export function log (step: string, data: unknown) {
  const line = `[${new Date().toISOString()}] ${step} ${JSON.stringify(data, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`
  console.log(line)
  appendFileSync(join(HERE, 'calls.log'), line + '\n')
}

const BCLI = ['exec', '-u', 'blits', 'settleup-bitcoind-1', 'bitcoin-cli', '-regtest']
export function bcli (...args: string[]): string {
  return execFileSync('docker', [...BCLI, ...args], { encoding: 'utf8' }).trim()
}
let minerLoaded = false
function ensureMiner () {
  if (minerLoaded) return
  if (!bcli('listwallets').includes('"miner"')) bcli('loadwallet', 'miner')
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
  bitcoind_rpc_username: 'user',
  bitcoind_rpc_password: 'password',
  bitcoind_rpc_host: '127.0.0.1',
  bitcoind_rpc_port: 18443,
  indexer_url: 'tcp://127.0.0.1:50001',
  proxy_endpoint: 'rpc://127.0.0.1:3000/json-rpc',
  announce_addresses: [],
  announce_alias: alias
})

export type Node = { name: Name, manager: any, account: any, pubkey: string }

export async function openNode (name: Name, opts: { dataDir?: string, vssUrl?: string, extra?: Record<string, unknown> } = {}): Promise<Node> {
  const dataDir = opts.dataDir ?? join(HERE, 'data', name, 'ln')
  mkdirSync(dataDir, { recursive: true })
  const cfg: any = { network: 'regtest', dataDir, ldkPeerListeningPort: PEER_PORT[name] }
  if (opts.vssUrl) { cfg.vssUrl = opts.vssUrl; cfg.vssAllowHttp = true }
  // dave forwards to private channels: RLN sets accept_forwards_to_priv_channels from this flag
  if (name === 'dave') cfg.enableVirtualChannelsV0 = true
  Object.assign(cfg, opts.extra)
  const manager = new WalletManagerRgbLightning(secrets()[name], cfg)
  const account = await manager.getAccount(0)
  await account.unlock(UNLOCK(name))
  const info = await account.getNodeInfo()
  return { name, manager, account, pubkey: info.pubkey }
}

export async function openAll (): Promise<Record<Name, Node>> {
  const out: Partial<Record<Name, Node>> = {}
  for (const n of NAMES) out[n] = await openNode(n)
  return out as Record<Name, Node>
}

export function closeAll (nodes: Record<string, Node>) {
  for (const n of Object.values(nodes)) { try { n.manager.dispose() } catch {} }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function waitFor<T> (what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 60000, everyMs = 500): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`)
    await sleep(everyMs)
  }
}
