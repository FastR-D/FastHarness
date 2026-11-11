import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { archiveFiles, inspectArchive, onlyArchive, releaseSource, source } from './release.mjs'

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run via npm exec --offline --call "node scripts/verify.mjs [archive] [manifest]"')
const manifest = resolve(process.argv[3] ?? 'artifacts/verified.json')
await mkdir(dirname(manifest), { recursive: true })
// Invalidate a previous success before any check that can fail.
await rm(manifest, { force: true })
const archive = process.argv[2] ? resolve(process.argv[2]) : await onlyArchive()
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const origin = process.env.GITHUB_ACTIONS === 'true' ? releaseSource(pkg) : source()
const artifact = await inspectArchive(archive)
const consumer = await mkdtemp(join(tmpdir(), 'harness-consumer-'))
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  execFileSync(process.execPath, [npm, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry=https://registry.npmjs.org/'], { cwd: consumer, stdio: 'inherit' })
  const installed = join(consumer, 'node_modules', '@fastrd', 'harness-transport')
  async function filesAt(root, prefix = '') {
    const entries = await readdir(join(root, prefix), { withFileTypes: true })
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? filesAt(root, prefix + entry.name + '/') : [prefix + entry.name]))).flat().sort()
  }
  assert.deepEqual(await filesAt(installed), archiveFiles, 'Unexpected installed public files')
  for (const file of archiveFiles) {
    assert.deepEqual(await readFile(join(installed, file)), execFileSync('tar', ['-xOf', archive, `package/${file}`]), `Installed bytes differ: ${file}`)
  }
  const tests = await readFile('tests/transport.test.mjs', 'utf8')
  const checkoutImport = "from '../dist/index.js'"
  assert.equal(tests.split(checkoutImport).length, 2, 'Expected one transport import in existing tests')
  await writeFile(join(consumer, 'transport.test.mjs'), tests.replace(checkoutImport, "from '@fastrd/harness-transport'"))
  // The original real-child-process scenarios now resolve the installed tarball by its public export.
  execFileSync(process.execPath, ['--test', 'transport.test.mjs'], { cwd: consumer, stdio: 'inherit' })
  await writeFile(join(consumer, 'consumer.mts'), `
import { JsonlRpcClient, RpcError } from '@fastrd/harness-transport'
import type { RpcCommand, JsonlRpcClientOptions, RpcMessage } from '@fastrd/harness-transport'
const command: RpcCommand = { command: process.execPath, args: [], cwd: process.cwd() }
const options: JsonlRpcClientOptions = { commandFactory: () => command }
const client = new JsonlRpcClient(options)
const message: RpcMessage = { method: 'smoke' }
const result: Promise<string> = client.request<string>(message.method!, {})
const error: RpcError = new RpcError('smoke', 'SMOKE')
void result; void error
`)
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--types', 'node', '--typeRoots', resolve('node_modules/@types'), join(consumer, 'consumer.mts')], { cwd: consumer, stdio: 'inherit' })
  assert.deepEqual(await inspectArchive(archive), artifact, 'Archive changed during verification')
  assert.deepEqual(process.env.GITHUB_ACTIONS === 'true' ? releaseSource(pkg) : source(), origin, 'Source changed during verification')
  const verified = { source: origin, artifact, checks: { installedBytes: 'passed', publicApiProcessTests: 'passed', types: 'passed' }, node: process.version, platform: process.platform }
  await writeFile(manifest, JSON.stringify(verified, null, 2) + '\n')
  console.log(JSON.stringify(verified, null, 2))
} finally {
  await rm(consumer, { recursive: true, force: true })
}
