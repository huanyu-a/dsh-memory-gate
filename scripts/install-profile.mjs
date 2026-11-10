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
 *
 * The script refuses to touch anything unless the profile looks like a DSH
 * profile, and it always leaves a `.bak-*` copy of package.json and
 * pnpm-lock.yaml behind so the change can be reverted by hand.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileArg = args.filter((one) => one !== '--dry-run')[0]
const profile = resolve(
  profileArg ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh', 'profiles', 'desktop'),
)

const fail = (message) => {
  console.error(`install-profile: ${message}`)
  process.exit(1)
}

// ---- guards ---------------------------------------------------------------

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
const runtimeRoots = [
  join(process.env['LOCALAPPDATA'] ?? '', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies'),
  join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies'),
]
const runtime = runtimeRoots.find((one) => one && existsSync(join(one, 'pnpm', 'bin', 'pnpm.cjs')))
if (runtime === undefined) {
  fail('cannot find the DSH runtime\'s bundled pnpm; run the install from the DSH desktop app instead')
}
const nodeExe = join(runtime, 'node', 'bin', 'node.exe')
const pnpmCjs = join(runtime, 'pnpm', 'bin', 'pnpm.cjs')
const pnpmVersion = execFileSync(nodeExe, [pnpmCjs, '--version'], { encoding: 'utf8' }).trim()

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

// ---- step 3: write the profile (backups first) ---------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
for (const name of ['package.json', 'pnpm-lock.yaml']) {
  const from = join(profile, name)
  copyFileSync(from, `${from}.bak-install-${stamp}`)
}

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

const lockPath = join(profile, 'pnpm-lock.yaml')
const lockLines = readFileSync(lockPath, 'utf8').split(/\r?\n/)
const dropped = []
const kept = []
let skipping = false
for (const line of lockLines) {
  // Importer entry: `      dsh-memory-gate:` then its specifier/version lines.
  if (/^\s{6}dsh-memory-gate:\s*$/.test(line)) {
    skipping = true
    dropped.push(line)
    continue
  }
  if (skipping) {
    if (/^\s{8}(specifier|version):/.test(line)) {
      dropped.push(line)
      continue
    }
    skipping = false
  }
  // Packages entry: `  dsh-memory-gate@file:...:` plus its indented body.
  if (/^\s{2}dsh-memory-gate@file:.*:\s*$/.test(line)) {
    skipping = true
    dropped.push(line)
    continue
  }
  if (skipping) {
    if (/^\s{4,}/.test(line) || line.trim() === '') {
      dropped.push(line)
      continue
    }
    skipping = false
  }
  kept.push(line)
}
if (kept.length === lockLines.length) {
  fail(`no lockfile record for ${pkg.name} was found in ${lockPath}; cannot force a re-extract safely`)
}
writeFileSync(lockPath, kept.join('\n'), 'utf8')
console.log(`install-profile: dropped ${dropped.length} stale lockfile line(s) for ${pkg.name}`)

// ---- step 5: install with the app's own pnpm ----------------------------

console.log('install-profile: installing…')
execFileSync(nodeExe, [pnpmCjs, 'install', '--ignore-scripts', '--config.confirmModulesPurge=false'], {
  cwd: profile,
  stdio: 'inherit',
})

// ---- step 6: prove the installed tree is the build we just made ---------

const installedEntry = join(target, 'lib', 'index.js')
if (!existsSync(installedEntry)) fail(`install finished but ${installedEntry} is missing`)

const fresh = readFileSync(join(resolve('lib'), 'index.js'), 'utf8')
const landed = readFileSync(installedEntry, 'utf8')
if (fresh !== landed) {
  fail(
    'the installed lib/index.js differs from the local build — pnpm almost certainly reused a cached ' +
      `extraction. Remove ${target} and re-run.`,
  )
}
if (existsSync(join(target, 'node_modules'))) {
  fail(
    `${target}/node_modules exists: this plugin would resolve its own dependency copies instead of the ` +
      "profile's. Install from a tarball (file:) rather than a link: dependency.",
  )
}

console.log(`install-profile: OK — ${pkg.name}@${pkg.version} installed into ${profile}`)
console.log('install-profile: restart the DSH desktop app to load it.')