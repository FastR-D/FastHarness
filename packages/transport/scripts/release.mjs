import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export const registry = 'https://registry.npmjs.org'
const packageName = '@fastrd/harness-transport'
export const archiveFiles = ['LICENSE', 'README.md', 'dist/index.d.ts', 'dist/index.js', 'package.json']
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
export const source = () => ({ head: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain', '--untracked-files=all') === '' })

export function releaseSource(pkg) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'FastR-D/FastHarness', 'Unexpected repository')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Publication requires a tag push')
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Publication requires a tag ref')
  const tag = `refs/tags/v${pkg.version}`
  assert.equal(process.env.GITHUB_REF, tag, 'Tag/version mismatch')
  const current = source()
  assert.equal(current.head, process.env.GITHUB_SHA, 'HEAD/GITHUB_SHA mismatch')
  assert.equal(current.clean, true, 'Publication requires a clean source checkout')
  assert.equal(git('rev-parse', `${tag}^{commit}`), current.head, 'Peeled tag/HEAD mismatch')
  execFileSync('git', ['merge-base', '--is-ancestor', current.head, 'refs/remotes/origin/main'])
  return { ...current, repository: process.env.GITHUB_REPOSITORY, tag, main: git('rev-parse', 'refs/remotes/origin/main') }
}

export async function inspectArchive(file) {
  const archive = resolve(file)
  const bytes = await readFile(archive)
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).sort()
  assert.deepEqual(files, archiveFiles.map(path => `package/${path}`).sort(), 'Unexpected archive contents')
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
  const expected = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(pkg.name, packageName, 'Unexpected package name')
  assert.deepEqual(pkg, expected, 'Archive/source package manifest mismatch')
  assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/FastR-D/FastHarness.git', directory: 'packages/transport' })
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: registry + '/' })
  assert.deepEqual(pkg.exports, { '.': { types: './dist/index.d.ts', import: './dist/index.js' } })
  return {
    file: archive.split(/[\\/]/).at(-1), name: pkg.name, version: pkg.version,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), files,
  }
}

export async function onlyArchive() {
  const archives = (await readdir('artifacts')).filter(file => file.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'Expected exactly one package archive')
  return resolve('artifacts', archives[0])
}

export async function verifiedArchive(archive, origin) {
  const artifact = await inspectArchive(archive)
  const verified = JSON.parse(await readFile('artifacts/verified.json', 'utf8'))
  assert.deepEqual(verified.source, origin, 'Verified source identity mismatch')
  assert.deepEqual(verified.artifact, artifact, 'Archive differs from verified manifest')
  assert.deepEqual(verified.checks, { installedBytes: 'passed', publicApiProcessTests: 'passed', types: 'passed' }, 'Final archive consumer checks must pass')
  return artifact
}

if (process.argv[2] === '--check-source') {
  console.log(JSON.stringify(releaseSource(JSON.parse(await readFile('package.json', 'utf8'))), null, 2))
}
