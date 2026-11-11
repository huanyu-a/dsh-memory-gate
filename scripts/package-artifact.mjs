/** Pack and consume the real artifact, including strict public declarations. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const directory = resolve('artifacts/ci/package')
const consumer = join(directory, 'consumer')
rmSync(directory, { recursive: true, force: true })
mkdirSync(consumer, { recursive: true })
const run = (command, args, cwd = resolve('.')) => {
  console.log(`::group::${command} ${args.join(' ')}`)
  // Only the `.cmd` shims (`npm`, `tar`, `tsc`) need a shell on Windows;
  // routing `node -e …` through `cmd.exe` would let it re-parse the quotes and
  // parentheses inside those snippets. `node -e` is always passed verbatim.
  const needsShell = process.platform === 'win32' && command !== 'node'
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
    shell: needsShell,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  console.log('::endgroup::')
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.error}`)
  return result
}

run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory])
const tarball = join(directory, `${pkg.name}-${pkg.version}.tgz`)
// Windows `tar` emits CRLF; normalise before matching so the same assertions
// hold on every platform.
const entries = run('tar', ['-tf', tarball]).stdout.split(/\r?\n/).filter(Boolean)
if (!entries.includes('package/cordis.patch.yml')) throw new Error('cordis.patch.yml missing from the artifact')
if (pkg.icon !== './icon.svg') throw new Error('package icon declaration missing or unexpected')
if (!entries.includes('package/icon.svg')) throw new Error('icon.svg missing from the artifact')
if (entries.some(name => /(?:^|\/)src\//.test(name) || /\.(?:ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name))) {
  throw new Error('TypeScript sources leaked into the artifact')
}
run('npm', ['init', '-y'], consumer)
const pinnedCohort = [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery',
].map(name => {
  const version = pkg.devDependencies[name]
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Package check requires an exact development cohort: ${name}`)
  }
  return `${name}@${version}`
})
run('npm', [
  'install', '--no-audit', '--no-fund', '--legacy-peer-deps=false', tarball, ...pinnedCohort,
  'typescript@5.9.3', 'react@18.2.0', 'react-dom@18.2.0', '@types/react@18.3.1', '@types/react-dom@18.3.1',
], consumer)
// Node is a real executable on every platform, so inline `-e` stays unquoted
// by any shell; only the `.cmd` shims above need `shell: true`.
run('node', ['-e', `import('${pkg.name}').then((m) => { if (m.name !== '${pkg.name}') throw new Error('host entry name mismatch') })`], consumer)
writeFileSync(join(consumer, 'check.mts'), `import { apply as applyHost } from '${pkg.name}'
import type { RemoteApi } from '${pkg.name}/client'
import type { Context } from '@deepseek-ai/cordis'
declare const ctx: Context
declare const api: RemoteApi
applyHost(ctx)
void api
`)
run(join(consumer, 'node_modules/.bin/tsc'), [
  '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--target', 'ES2022', '--lib', 'ES2022,DOM', '--jsx', 'react-jsx', 'check.mts',
], consumer)
run('node', ['-e', `
  const fs = require('fs')
  const path = require.resolve('${pkg.name}/client')
  const head = fs.readFileSync(path, 'utf8').slice(0, 200)
  if (!head.startsWith('window.__ModuleLoader__.load({')) throw new Error('client wrapper missing')
  if (!head.includes('id: "' + '${pkg.name}' + '"')) throw new Error('client module id mismatch')
  console.log('artifact OK:', require('${pkg.name}/package.json').version)
`], consumer)
console.log(`Package artifact passed: ${pkg.name}@${pkg.version}`)
