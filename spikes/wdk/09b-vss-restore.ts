// Q9 retry: restore bob from VSS into an empty dataDir, clearing the fence after init and before unlock.
// Reaches into the binding (spike only): WDK's unlock() does init + unlock in one call, and
// clearVssFence before init fails with Rln(NotInitialized).
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import { HERE, log, secrets, loadState, PEER_PORT, UNLOCK } from './lib.ts'
const dir = join(HERE, 'data', 'bob', 'ln'); mkdirSync(dir, { recursive: true })
const mgr = new WalletManagerRgbLightning(secrets().bob, { network: 'regtest', dataDir: dir, ldkPeerListeningPort: PEER_PORT.bob + 20, vssUrl: 'http://127.0.0.1:8081/vss', vssAllowHttp: true })
const acc = await mgr.getAccount(0)
const b = (mgr as any)._binding
try { b.ensureNode().initWithNativeExternalSigner(b._signer); b._sdkInitDone = true; log('init', 'ok') } catch (e) { log('init', (e as Error).message) }
log('clearVssFence', await acc.clearVssFence('unused').catch((e: Error) => ({ error: e.message })))
const t = Date.now()
log('unlock', await acc.unlock(UNLOCK('bob')).catch((e: Error) => ({ error: e.message })))
log('unlock-ms', Date.now() - t)
const info = await acc.getNodeInfo()
const { assetId } = loadState()
log('restored', { pubkey: info.pubkey, num_channels: info.num_channels, chans: ((await acc.listChannels()) as any[]).map(c => ({ id: c.channel_id.slice(0, 8), status: c.status, asset: `${c.asset_local_amount}/${c.asset_remote_amount}`, sat: c.local_balance_sat })), dusd: await acc.getAssetBalance(assetId).catch((e: Error) => e.message) })
try { mgr.dispose() } catch {}
