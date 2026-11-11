/**
 * Install this plugin into a DSH profile the way the harness itself would,
 * with the two footguns this repo hit while doing it by hand fixed:
 *
 * 1. `pnpm install` reports "Already up to date" and silently keeps the *old*
 *    tarball contents. A lockfile records a `file:` dependency's integrity, so
 *    replacing the .tgz without touching the specifier is invisible to it.
 *    Every install therefore copies the fresh tarball and removes the previous
 *    package directory first, so the extracted tree cannot be reused.
 * 2. `link:` dependencies resolve their own `node_modules` instead of the
 *    profile's, which hands this plugin a different `@deepseek-ai/schemastery`
 *    than every other bundle in the same profile. A `file:` tarball lets pnpm
 *    hoist the dependency and share one copy.
 *
 * Usage:
 *   node scripts/install-profile.mjs                 # default desktop profile
 *   node scripts/install-profile.mjs <profile-dir>
 *   node scripts/install-profile.mjs <profile-dir> --dry-run
 *   node scripts/install-profile.mjs <profile-dir> --allow-running
 *   node scripts/install-profile.mjs <profile-dir> --wait-for-exit 300
 *
 * The script refuses to touch anything unless the profile looks like a DSH
 * profile, and it always leaves a `.bak-*` copy of package.json and
 * pnpm-lock.yaml behind so the change can be reverted by hand.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pruneMemoryGateLock } from './profile-lock.mjs'
import { dshRunning } from './rollback-profile.mjs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const allowRunning = args.includes('--allow-running')
const waitFlag = args.indexOf('--wait-for-exit')
// `--wait-for-exit` alone means "wait the default"; a following number is the timeout.
const waitSeconds = waitFlag === -1
  ? undefined
  : Number.isFinite(Number(args[waitFlag + 1])) ? Number(args[waitFlag + 1]) : 300
const consumed = new Set(['--dry-run', '--allow-running'])
if (waitFlag !== -1) {
  consumed.add('--wait-for-exit')
  if (Number.isFinite(Number(args[waitFlag + 1]))) consumed.add(args[waitFlag + 1])
}
const profileArg = args.filter((one) => !consumed.has(one))[0]
const profile = resolve(
  profileArg ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh', 'profiles', 'desktop'),
)

const fail = (message) => {
  console.error(`install-profile: ${message}`)
  process.exit(1)
}

// ---- guards ---------------------------------------------------------------

/**
 * Block until the desktop app has no processes left.
 * @param seconds - how long to wait before giving up.
 * @returns whether the app is gone.
 */
async function waitForExit(seconds) {
  const deadline = Date.now() + seconds * 1000
  let announced = false
  while (Date.now() < deadline) {
    if (!dshRunning()) return true
    if (!announced) {
      console.log(`install-profile: DSH is running — waiting up to ${String(seconds)}s for it to exit (quit the app now)`)
      announced = true
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  return !dshRunning()
}

// The application rewrites the profile's manifest/lockfile on its own schedule
// and keeps the plugin's modules loaded, so installing underneath a running
// app can be undone on exit or leave a half-replaced tree.
if (!allowRunning && dshRunning()) {
  if (waitSeconds === undefined) {
    fail('DSH is still running — quit it completely first, pass --wait-for-exit to let this wait, or --allow-running if you know it is safe')
  }
  if (!await waitForExit(waitSeconds)) {
    fail(`DSH is still running after waiting ${String(waitSeconds)}s — nothing was written`)
  }
  console.log('install-profile: DSH has exited, continuing')
}

if (!existsSync(join(profile, 'package.json'))) {
  fail(`no package.json under ${profile} — is that a DSH profile directory?`)
}
const profilePkgPath = join(profile, 'package.json')
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
if (typeof profilePkg?.dsh?.profile?.bundles !== 'object') {
  fail(`${profilePkgPath} has no dsh.profile.bundles — refusing to edit a non-DSH profile`)
}
if (!existsSync(join(profile, 'pnpm-lock.yaml'))) {
  fail(`${profile} has no pnpm-lock.yaml — install a bundle through DSH once so the profile is initialised`)
}

// ---- the DSH runtime's own pnpm ------------------------------------------
// The desktop app ships a specific pnpm (11.x) and reads `nodeLinker` from the
// profile's pnpm-workspace.yaml. A different global pnpm silently ignores that
// setting and relinks node_modules into an isolated layout, which leaves the
// profile with a handful of visible packages instead of the hoisted set.
// `LOCALAPPDATA` only exists for Windows processes. Run from WSL (where the repo
// may live on the Linux filesystem) and every root below collapses to a relative
// path, so the runtime looks missing even though it is installed. Fall back to
// the Windows user's AppData under /mnt/c when the variable is absent.
const windowsLocalAppData = process.env['LOCALAPPDATA']
  ?? (process.env['USERPROFILE'] === undefined || process.env['USERPROFILE'].startsWith('/')
    ? '/mnt/c/Users/' + (process.env['USER'] ?? 'WIN11') + '/AppData/Local'
    : join(process.env['USERPROFILE'], 'AppData', 'Local'))
const runtimeRoots = [
  join(windowsLocalAppData, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies'),
  join(windowsLocalAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies'),
]
const runtime = runtimeRoots.find((one) => one && existsSync(join(one, 'pnpm', 'bin', 'pnpm.cjs')))
if (runtime === undefined) {
  fail('cannot find the DSH runtime\'s bundled pnpm; run the install from the DSH desktop app instead')
}
const nodeExe = join(runtime, 'node', 'bin', 'node.exe')
const pnpmCjs = join(runtime, 'pnpm', 'bin', 'pnpm.cjs')

/**
 * Translate a path for a Windows child process.
 *
 * The DSH runtime ships a Windows `node.exe`, so pnpm always runs as a Windows
 * process with the Windows pnpm build. When this script itself runs under WSL
 * with the profile on `/mnt/c`, handing it `/mnt/c/...` makes Windows resolve the
 * path against the current drive (`\\wsl.localhost\Ubuntu\mnt\c\...`) and the
 * module is not found. Map the `/mnt/<drive>/` prefix to `<DRIVE>:\` first.
 * @param value - a POSIX or Windows path.
 * @returns the path in a form the Windows child can open.
 */
function forWindows(value) {
  const mapped = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(value)
  if (mapped === null) return value
  return `${mapped[1].toUpperCase()}:\\${mapped[2].replaceAll('/', '\\')}`
}

const pnpmVersion = execFileSync(nodeExe, [forWindows(pnpmCjs), '--version'], { encoding: 'utf8' }).trim()

// ---- step 1: build and pack the artifact ---------------------------------
// Always rebuild and repack. A leftover tarball looks like a valid artifact but
// its contents can predate the current build — that is exactly how a stale
// bundle gets installed while every check on the *artifact* still passes. Only
// the source-to-artifact chain can be trusted, so run it every time.

const tarballName = `${pkg.name}-${pkg.version}.tgz`
const artifactDir = resolve('artifacts')
const tarball = join(artifactDir, tarballName)
if (dryRun) {
  console.log(`install-profile: [dry] would run \`npm run build && npm pack\` to produce ${tarball}`)
} else {
  console.log('install-profile: building and packing the artifact…')
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  rmSync(tarball, { force: true })
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', artifactDir], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

// ---- step 2: plan --------------------------------------------------------

const target = join(profile, 'node_modules', pkg.name)
const specifier = `file:${tarballName}`
const plan = [
  `profile      : ${profile}`,
  `pnpm         : ${pnpmVersion} (${runtime})`,
  `artifact     : ${tarball}${existsSync(tarball) ? '' : ' (to be built)'}`,
  `dependency   : ${pkg.name} -> ${specifier}`,
  `bundle       : ${pkg.name} appended to dsh.profile.bundles`,
  `replacing    : ${existsSync(target) ? target : '(nothing installed yet)'}`,
]
console.log(plan.map((line) => `  ${line}`).join('\n'))
if (dryRun) {
  console.log('install-profile: --dry-run, nothing written')
  process.exit(0)
}

// Preflight before changing the manifest, artifact or installed tree.
// dsh-memory-header-gate@file: records carry a stale integrity hash after repacking.
const lockPath = join(profile, 'pnpm-lock.yaml')
let prunedLock
try {
  prunedLock = pruneMemoryGateLock(readFileSync(lockPath, 'utf8'), {
    allowMissing: !existsSync(target) && profilePkg.dependencies?.[pkg.name] === undefined,
  })
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

// ---- step 3: write the profile (backups first) ---------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
for (const name of ['package.json', 'pnpm-lock.yaml']) {
  const from = join(profile, name)
  copyFileSync(from, `${from}.bak-install-${stamp}`)
}

// Preserve the old artifact too: same-version upgrades overwrite its path.
const previousTarball = join(profile, tarballName)
if (existsSync(previousTarball)) copyFileSync(previousTarball, `${previousTarball}.bak-install-${stamp}`)

profilePkg.dependencies = { ...profilePkg.dependencies, [pkg.name]: specifier }
if (!profilePkg.dsh.profile.bundles.includes(pkg.name)) profilePkg.dsh.profile.bundles.push(pkg.name)
writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8')

// ---- step 4: copy the artifact and forget the previous extraction -------
// A `file:` dependency's lockfile record carries the tarball's integrity hash.
// Replacing the .tgz while keeping the specifier leaves that record stale, and
// pnpm then reports "Already up to date" and reuses the previously extracted
// tree — the new build never lands. Dropping the importer entry and the
// package record forces pnpm to re-hash and re-extract.
copyFileSync(tarball, join(profile, tarballName))
rmSync(target, { recursive: true, force: true })

writeFileSync(lockPath, prunedLock.text, 'utf8')
console.log(`install-profile: dropped ${prunedLock.removed} stale lockfile record(s) for ${pkg.name}`)

// ---- step 5: install with the app's own pnpm ----------------------------

console.log('install-profile: installing…')
execFileSync(nodeExe, [forWindows(pnpmCjs), 'install', '--ignore-scripts', '--config.confirmModulesPurge=false'], {
  // The child is a Windows process, so its working directory must be a path
  // Windows understands as well.
  cwd: forWindows(profile),
  stdio: 'inherit',
})

// ---- step 6: prove the installed tree is the build we just made ---------
// Compare every emitted file, not just the host entry: the client bundle is
// what renders the card and the per-model dropdown, and a stale `lib/client.js`
// with a fresh `lib/index.js` would run a host the UI cannot talk to. A stale
// entry can only be caught by content, because pnpm preserves tarball mtimes.
const builtLib = resolve('lib')
const installedLib = join(target, 'lib')
if (!existsSync(join(installedLib, 'index.js'))) fail(`install finished but ${installedLib}/index.js is missing`)

const walk = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, base, out)
    else out.push(relative(base, path))
  }
  return out
}
const builtFiles = walk(builtLib)
const stale = []
for (const file of builtFiles) {
  const landedPath = join(installedLib, file)
  if (!existsSync(landedPath) || !readFileSync(join(builtLib, file)).equals(readFileSync(landedPath))) {
    stale.push(file)
  }
}
if (stale.length > 0) {
  fail(
    `the installed lib/ differs from the local build in ${String(stale.length)} file(s): ` +
      `${stale.slice(0, 5).join(', ')}${stale.length > 5 ? '…' : ''} — pnpm almost certainly reused a ` +
      `cached extraction. Remove ${target} and re-run.`,
  )
}
if (existsSync(join(target, 'node_modules'))) {
  fail(
    `${target}/node_modules exists: this plugin would resolve its own dependency copies instead of the ` +
      "profile's. Install from a tarball (file:) rather than a link: dependency.",
  )
}

console.log(`install-profile: verified ${String(builtFiles.length)} file(s) byte for byte`)
console.log(`install-profile: OK — ${pkg.name}@${pkg.version} installed into ${profile}`)
console.log('install-profile: restart the DSH desktop app to load it.')