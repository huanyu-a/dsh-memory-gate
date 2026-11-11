/**
 * Guards the install path's two silent-staleness traps, both of which have
 * already put an old bundle into a live profile while every other check stayed
 * green:
 *
 *   1. `install-profile.mjs` must always rebuild and repack. Reusing a leftover
 *      tarball installs whatever was built last time, not what is in `src/`.
 *   2. The lockfile record of a `file:` dependency carries the tarball's
 *      integrity. Replacing the .tgz without dropping that record makes pnpm
 *      report "Already up to date" and reuse the previous extraction.
 *
 * These are static assertions over the script source: the script itself drives
 * npm/pnpm against a real profile, which a unit test must not do.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./install-profile.mjs', import.meta.url), 'utf8')

test('always rebuilds and repacks instead of trusting an existing tarball', () => {
  // A guard of the shape `if (!existsSync(tarball)) { …build… }` is the bug.
  assert.doesNotMatch(
    source,
    /if\s*\(\s*!\s*existsSync\(\s*tarball\s*\)\s*\)/,
    'install-profile must not skip the build when a tarball is already present',
  )
  assert.match(source, /execFileSync\('npm', \['run', 'build'\]/, 'expected an unconditional build step')
  assert.match(source, /'pack'/, 'expected an unconditional pack step')
  // The stale file is removed before repacking so a failed pack cannot leave
  // the previous artifact in place to be picked up by the next run.
  assert.match(source, /rmSync\(tarball,\s*\{\s*force:\s*true\s*\}\)/, 'expected the old tarball to be removed before packing')
})

test('drops the stale lockfile record for the file: dependency', () => {
  assert.match(source, /dsh-memory-header-gate@file:/, 'the script must recognise the packages-section record it prunes')
  assert.match(source, /pnpm-lock\.yaml/, 'expected the lockfile to be rewritten')
  assert.match(source, /integrity/i, 'the reason for pruning (a stale integrity hash) should be documented')
  // Refusing to continue when nothing matched prevents a silent no-op that
  // would leave pnpm free to reuse the cached extraction.
  assert.match(source, /pruneMemoryGateLock/, 'expected preflighted lockfile transformation')
  assert.ok(source.indexOf('prunedLock = pruneMemoryGateLock') < source.indexOf('profilePkg.dependencies ='), 'preflight must precede profile mutations')
})

test('verifies every installed file, not just the host entry', () => {
  // The client bundle renders the card and the dropdown; a fresh host running
  // against a stale client would still "pass" a host-only check. `pnpm` also
  // preserves tarball mtimes, so content is the only reliable signal.
  assert.match(source, /const builtFiles = walk\(builtLib\)/, 'expected a walk of the built lib directory')
  assert.match(source, /readFileSync\(join\(builtLib, file\)\)\.equals/, 'expected a per-file content comparison')
  assert.match(source, /verified \$\{String\(builtFiles\.length\)\} file\(s\) byte for byte/, 'expected the count to be reported')
})

test('refuses an installation that would resolve its own dependencies', () => {
  // A nested node_modules means the plugin gets its own schemastery copy
  // instead of the profile's, which is the link: failure mode.
  assert.match(source, /join\(target, 'node_modules'\)/, 'expected a nested-node_modules check')
  assert.match(source, /link:/, 'the link: hazard should be named in the failure message')
})

test('uses the bundled pnpm from the DSH runtime rather than whatever is on PATH', () => {
  assert.match(source, /dsh-primary-runtime/, 'expected the DSH runtime to be located')
  assert.match(source, /pnpm["']/, 'expected the bundled pnpm entry point')
  assert.doesNotMatch(
    source,
    /execFileSync\('pnpm'/,
    'invoking a PATH pnpm would relink the profile into an isolated layout',
  )
})

test('backs up both profile files before editing them', () => {
  assert.match(source, /\['package\.json', 'pnpm-lock\.yaml'\]/, 'expected both files to be listed for backup')
  assert.match(source, /\.bak-install-/, 'expected a timestamped backup suffix')
})

test('refuses to edit anything that is not a DSH profile', () => {
  assert.match(source, /dsh\.profile\.bundles/, 'expected the bundle list to be validated')
  assert.match(source, /refusing to edit a non-DSH profile/, 'expected an explicit refusal')
})

test('translates /mnt paths for the Windows child it spawns', () => {
  // The runtime's node.exe and pnpm are Windows binaries. Handed "/mnt/c/..."
  // they resolve it against the current drive and the module is not found —
  // measured as: Error: Cannot find module '\\wsl.localhost\Ubuntu\mnt\c\...'.
  assert.match(source, /function forWindows\(value\)/)
  assert.match(source, /\^\\\/mnt\\\/\(\[a-zA-Z\]\)/)
  // Both the pnpm entry point and the install cwd go through it.
  assert.match(source, /forWindows\(pnpmCjs\)/)
  assert.match(source, /cwd: forWindows\(profile\)/)
})

test('finds the runtime from WSL, where LOCALAPPDATA is not set', () => {
  // Running under WSL collapsed every runtime root to a relative path, so the
  // installer reported "cannot find the DSH runtime's bundled pnpm" even though
  // the runtime was installed.
  assert.match(source, /const windowsLocalAppData =/)
  assert.match(source, /\/mnt\/c\/Users\//)
})
