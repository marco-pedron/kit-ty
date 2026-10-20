// A: published versions vs the fixes missing in spike 2 (createWithStorage, RLN >= 0.15).
// Usage: node 01-versions.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import rln from '@utexo/rgb-lightning-node-nodejs'
import { log } from './lib.ts'

const npmView = (pkg: string) => JSON.parse(execFileSync('npm', ['view', pkg, 'dist-tags', 'version', '--json'], { encoding: 'utf8' }))
for (const p of ['@utexo/wdk-rgb-lightning', '@utexo/rgb-lightning-node-nodejs', '@utexo/wdk-wallet-rgb']) {
  log('A.npm', { pkg: p, ...npmView(p) })
}
const wdkPkg = JSON.parse(readFileSync(new URL('./node_modules/@utexo/wdk-rgb-lightning/package.json', import.meta.url), 'utf8'))
const bindPkg = JSON.parse(readFileSync(new URL('./node_modules/@utexo/rgb-lightning-node-nodejs/package.json', import.meta.url), 'utf8'))
const prov = JSON.parse(readFileSync(new URL('./node_modules/@utexo/rgb-lightning-node-nodejs/index-darwin-arm64.provenance.json', import.meta.url), 'utf8'))
const bindingSrc = readFileSync(new URL('./node_modules/@utexo/wdk-rgb-lightning/src/node-binding.js', import.meta.url), 'utf8')
log('A.installed', {
  wdk: wdkPkg.version,
  wdkSource: 'github:UTEXO-Protocol/wdk-rgb-lightning#a5d3439 (not on npm)',
  wdkPeer: wdkPkg.peerDependencies['@utexo/rgb-lightning-node-nodejs'],
  binding: bindPkg.version,
  rlnCommit: prov.commit,
  lightningCommit: prov.lightningCommit,
  createWithStorageExported: typeof (rln as any).NativeExternalSigner.createWithStorage === 'function',
  wdkUsesCreateWithStorage: bindingSrc.includes('NativeExternalSigner.createWithStorage('),
  runtime: (rln as any).getRuntimeInfo?.()
})
