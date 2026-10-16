import { openNode, log } from './lib.ts'
const a = await openNode('alice')
const u = await a.account.listUnspents(false)
console.log(JSON.stringify(u).slice(0, 2500))
try { a.manager.dispose() } catch {}
