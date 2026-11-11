/**
 * Restore a DSH profile from a full directory backup made before an install.
 *
 * The installer only backs up `package.json`, `pnpm-lock.yaml` and the previous
 * tarball. That is enough to redo the dependency step by hand, but not enough
 * to undo a partial install, so rollback needs a whole-profile copy. This
 * script never deletes anything: the current profile is renamed aside
 * (`<profile>.pre-rollback-<stamp>`) before the backup is copied into place.
 *
 * Usage:
 *   node scripts/rollback-profile.mjs --backup <dir> [--profile <dir>]
 *   node scripts/rollback-profile.mjs --backup <dir> --yes
 *
 * Without `--yes` it only prints the plan. It also refuses to run while DSH is
 * still open: the application rewrites the profile on exit, which would undo
 * the restore.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Read from the manifest rather than repeating the name: a rename would
// otherwise leave these scripts validating the wrong package, silently.
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/**
 * Check that a directory really is a restorable profile backup.
 * @param backup - the backup directory.
 * @param profile - the profile directory it would replace.
 * @returns the problems found; empty means the rollback can proceed.
 */
export function rollbackProblems(backup, profile) {
  const problems = []
  if (!existsSync(backup)) return [`backup directory does not exist: ${backup}`]
  if (!statSync(backup).isDirectory()) problems.push(`backup is not a directory: ${backup}`)
  if (resolve(backup) === resolve(profile)) problems.push('backup and profile are the same directory')

  const manifestPath = join(backup, 'package.json')
  if (!existsSync(manifestPath)) {
    problems.push(`backup has no package.json: ${manifestPath}`)
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const bundles = manifest?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) {
        problems.push('backup manifest has no dsh.profile.bundles — not a DSH profile')
      } else if (!bundles.includes(PACKAGE)) {
        problems.push(`backup manifest does not list ${PACKAGE} as a bundle`)
      }
      if (manifest?.dependencies?.[PACKAGE] === undefined) {
        problems.push(`backup manifest has no ${PACKAGE} dependency`)
      }
    } catch (error) {
      problems.push(`backup package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!existsSync(join(backup, 'pnpm-lock.yaml'))) problems.push('backup has no pnpm-lock.yaml')
  const installed = join(backup, 'node_modules', PACKAGE, 'package.json')
  if (!existsSync(installed)) {
    problems.push(`backup has no installed plugin (${installed})`)
  } else {
    try {
      const plugin = JSON.parse(readFileSync(installed, 'utf8'))
      if (plugin.name !== PACKAGE) problems.push(`installed plugin is "${String(plugin.name)}", not ${PACKAGE}`)
    } catch (error) {
      problems.push(`installed plugin package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems
}

/**
 * Whether DSH still has processes open.
 *
 * Two shapes count: the desktop shell (`DeepSeek Harness.exe`) and a
 * command-line runtime, which runs inside `node.exe` with the app's own runtime
 * path in its command line. Checking only the first would let an installer
 * replace the profile under a live `dsh web`.
 *
 * @param probes - injectable for tests; defaults to the real Windows probes.
 * @returns whether any DSH process appears to be running.
 */
export function dshRunning(probes = {}) {
  const list = probes.list ?? (() => execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }))
  const count = probes.count ?? (() => Number.parseInt(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write((Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
      + '| Where-Object { $_.CommandLine -match \'DeepSeek Harness|dsh-personal|\\\\dsh\\\\\' } '
      + '| Measure-Object).Count)',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(), 10))

  try {
    if (list().split(/\r?\n/).some((line) => /"DeepSeek Harness\.exe"/i.test(line))) return true
  } catch {
    // A non-Windows host has no tasklist; fall through to the node probe.
  }
  try {
    // A failed or unparsable probe must not block an install on a host that
    // simply cannot answer, so NaN counts as "not running".
    return count() > 0
  } catch {
    return false
  }
}

/**
 * Replace `profile` with `backup`, keeping the old tree.
 *
 * The current profile is renamed aside rather than deleted, both so the change
 * stays reversible and because a copy over a live tree can merge stale files.
 * Callers are expected to have run {@link rollbackProblems} first.
 * @param backup - the backup directory to restore.
 * @param profile - the profile directory to replace.
 * @param stamp - suffix for the aside directory.
 * @returns the path the previous profile was moved to, if it existed.
 */
export function performRollback(backup, profile, stamp) {
  const aside = `${profile}.pre-rollback-${stamp}`
  let moved
  if (existsSync(profile)) {
    renameSync(profile, aside)
    moved = aside
  }
  cpSync(backup, profile, { recursive: true })
  return moved
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const yes = args.includes('--yes')
  const backupArg = flag('--backup')
  const profile = resolve(
    flag('--profile') ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh', 'profiles', 'desktop'),
  )
  if (backupArg === undefined) {
    console.error('rollback-profile: --backup <dir> is required')
    process.exit(1)
  }
  const backup = resolve(backupArg)

  const problems = rollbackProblems(backup, profile)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`rollback-profile: ${problem}`)
    process.exit(1)
  }

  if (dshRunning()) {
    console.error('rollback-profile: DSH is still running — quit it completely first, or the restore will be overwritten on exit')
    process.exit(1)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const aside = `${profile}.pre-rollback-${stamp}`
  console.log(`rollback-profile: backup ${backup}`)
  console.log(`rollback-profile: profile ${profile}`)
  console.log(`rollback-profile: current profile would move to ${aside}`)
  console.log(`rollback-profile: ${backup} would be copied into ${profile}`)
  if (!yes) {
    console.log('rollback-profile: dry run — pass --yes to perform the rollback')
    return
  }

  const moved = performRollback(backup, profile, stamp)
  if (moved !== undefined) console.log(`rollback-profile: moved current profile to ${moved}`)
  const entry = join(profile, 'node_modules', PACKAGE, 'lib', 'index.js')
  if (!existsSync(entry)) {
    console.error(`rollback-profile: restore finished but ${entry} is missing — restore ${aside} by hand`)
    process.exit(1)
  }
  const remaining = readdirSync(backup).length
  console.log(`rollback-profile: restored ${remaining} top-level entries; the previous profile is at ${aside}`)
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('rollback-profile.mjs')) {
  main()
}
