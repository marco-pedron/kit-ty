// D (trap): after a crash the VSS fence of the dead instance blocks unlock. Try clearVssFence
// before unlock (spike 2: NotInitialized) and report. Usage: node 09b-clear-fence.ts charlie
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import { log, errMsg, secrets, nodeConfig, UNLOCK, closeNode, type Name } from './lib.ts'
const name = (process.argv[2] ?? 'charlie') as Name
const m = new WalletManagerRgbLightning(secrets()[name], nodeConfig(name, { vssUrl: 'http://127.0.0.1:8091/vss' }))
const a = await m.getAccount(0)
for (const pw of ['', 'password']) {
  try { log('D.clearFence', { pw: pw ? 'non-empty' : 'empty', r: await a.clearVssFence(pw) }) } catch (e) { log('D.clearFence.error', { pw: pw ? 'non-empty' : 'empty', e: errMsg(e) }) }
}
try { await a.unlock(UNLOCK(name)); log('D.clearFence.unlock', 'ok'); await closeNode({ name, manager: m, account: a, pubkey: '' }) } catch (e) { log('D.clearFence.unlock.error', errMsg(e)) }
process.exit(0)
