// Post-install verification: one command instead of the hand-checked
// PowerShell lines in DEPLOY.md. It answers "is the NEW build the one the app
// will load?" — a question the version number cannot answer, because the
// published version is unchanged across this upgrade.
//
//   node scripts/verify-install.mjs [profile-dir]
//
// Exit code 0 means every check passed; 1 means at least one failed. Each line
// prints PASS/FAIL so a partial install is visible at a glance.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const profile = resolve(process.argv[2]
  ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh', 'profiles', 'desktop'))
const installed = join(profile, 'node_modules', pkg.name)

const results = []
const check = async (label, run) => {
  try {
    const [ok, detail] = await run()
    results.push({ label, ok, detail })
  } catch (error) {
    results.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

await check('profile is a DSH profile', () => {
  const file = join(profile, 'package.json')
  if (!existsSync(file)) return [false, `no package.json under ${profile}`]
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  return [typeof manifest?.dsh?.profile?.bundles === 'object', 'has dsh.profile.bundles']
})

await check('plugin is installed', () => {
  if (!existsSync(installed)) return [false, `missing ${installed}`]
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  return [manifest.name === pkg.name, `${String(manifest.name)}@${String(manifest.version)}`]
})

await check('manifest depends on the local tarball', () => {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  const spec = manifest?.dependencies?.[pkg.name]
  return [typeof spec === 'string' && spec.startsWith('file:'), String(spec ?? 'absent')]
})

await check('manifest lists the bundle', () => {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  const present = Array.isArray(bundles)
    ? bundles.includes(pkg.name)
    : typeof bundles === 'object' && bundles !== null && Object.hasOwn(bundles, pkg.name)
  return [present, present ? 'registered' : 'not registered']
})

// The decisive check: both halves must carry markers that only the new build
// has. Version-stamp comparison cannot distinguish the two builds.
await check('host half is the new build', () => {
  const file = join(installed, 'lib', 'index.js')
  if (!existsSync(file)) return [false, 'lib/index.js missing']
  const body = readFileSync(file, 'utf8')
  // `name-conflict` and `name-duplicate` belong here: an intermediate build
  // already carried the first four markers, so without them this check cannot
  // tell that build from one that also closes the case-insensitive header holes.
  const markers = ['trustedOrigins', 'removeHeaderNames', 'migratedAt', 'name-reserved', 'name-conflict', 'name-duplicate']
  const missing = markers.filter(mark => !body.includes(mark))
  return [missing.length === 0, missing.length === 0 ? `${String(markers.length)} markers` : `missing ${missing.join(', ')}`]
})

// The wrapper and module id are identical in both builds, so they cannot tell
// them apart: these markers were added with the snapshot work and are absent
// from the build this upgrade replaces.
await check('client half is the new build', () => {
  const file = join(installed, 'lib', 'client.js')
  if (!existsSync(file)) return [false, 'lib/client.js missing']
  const body = readFileSync(file, 'utf8')
  const wrapped = body.startsWith('window.__ModuleLoader__.load({') && body.includes(`id: "${pkg.name}"`)
  if (!wrapped) return [false, 'module wrapper or id wrong']
  const markers = ['issueHeaderNameReserved', 'issueHeaderNameDuplicate', 'issueNameConflict', 'issueSaveBlockedByIdentity']
  const missing = markers.filter(mark => !body.includes(mark))
  return [missing.length === 0, missing.length === 0 ? 'wrapper intact, new markers present' : `wrapper intact but missing ${missing.join(', ')}`]
})

await check('lockfile records the local tarball', () => {
  const file = join(profile, 'pnpm-lock.yaml')
  if (!existsSync(file)) return [false, 'pnpm-lock.yaml missing']
  return [readFileSync(file, 'utf8').includes(`${pkg.name}@file:`), 'importer record present']
})

await check('pin store is readable', async () => {
  // The directory name is the plugin's cordis ROW id (`memory-gate`), which
  // deliberately differs from the package name (`dsh-memory-header-gate`) — deriving
  // it from the manifest would silently inspect a directory that never exists,
  // and "no pins yet" would then read as a pass.
  const home = process.env['DSH_HOME']?.trim()
    || join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh')
  // An explicit `--storage=<dir>` names the directory outright: this keeps the
  // check meaningful for a lone copy of the script (no source tree, and a
  // minified bundle may spell the call differently).
  const override = process.argv.find(one => one.startsWith('--storage='))?.slice('--storage='.length)
  if (override !== undefined) {
    const file = join(override, 'sessions.json')
    if (!existsSync(file)) return [true, `${override} holds no pins yet`]
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return [parsed?.version === 1, `${String(Object.keys(parsed?.sessions ?? {}).length)} pin(s)`]
  }
  // Source first, bundle second: the source is authoritative and always
  // present beside this script, while a minified bundle may spell the call
  // differently. The bundle is only a fallback for a lone copy of this script.
  const sources = [new URL('../src/store.ts', import.meta.url).pathname, join(installed, 'lib', 'index.js')]
  let ns
  for (const source of sources) {
    if (!existsSync(source)) continue
    const text = readFileSync(source, 'utf8')
    ns = /\(dshHome\([^)]*\),\s*['"]storage['"],\s*['"]([^'"]+)['"]\)/.exec(text)?.[1]
      ?? /"(?:storage)",\s*"([^"]+)"/.exec(text)?.[1]
    if (ns !== undefined) break
  }
  if (ns === undefined) throw new Error('cannot determine the storage directory from the bundle or the source')
  const file = join(home, 'storage', ns, 'sessions.json')
  if (!existsSync(file)) return [true, 'no pins yet (normal on a fresh install)']
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const count = Object.keys(parsed?.sessions ?? {}).length
  return [parsed?.version === 1, `${String(count)} pin(s)`]
})

const failed = results.filter(row => !row.ok)
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.label}${row.detail === undefined ? '' : ` — ${row.detail}`}`)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed for ${profile}`)
if (failed.length > 0) {
  console.log('See DEPLOY.md for the rollback procedure; do not keep using a half-installed plugin.')
  process.exit(1)
}
console.log('Restart DSH, then expand 「模型选项」 on each model row and confirm the identity picker appears.')
