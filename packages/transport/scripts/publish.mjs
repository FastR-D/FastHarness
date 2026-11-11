import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { inspectArchive, onlyArchive, registry, releaseSource, verifiedArchive } from './release.mjs'

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run through npm run publish:tag')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const origin = releaseSource(pkg)
const archive = await onlyArchive()
const artifact = await verifiedArchive(archive, origin)
const { integrity } = artifact
const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`)
if (response.ok) {
  if ((await response.json()).dist.integrity !== integrity) throw new Error('Different published bytes already exist; refusing publication')
  console.log(`Already published with identical integrity: ${pkg.name}@${pkg.version}`)
} else {
  if (response.status !== 404) throw new Error(`Registry lookup failed: ${response.status}`)
  assert.deepEqual(releaseSource(pkg), origin, 'Source changed before publication')
  assert.deepEqual(await inspectArchive(archive), artifact, 'Archive changed before publication')
  const result = spawnSync(process.execPath, [npm, 'publish', archive, '--access=public', '--provenance', '--registry=' + registry,
    '--tag=' + (pkg.version.includes('-') ? 'next' : 'latest')], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Publication failed')
}
