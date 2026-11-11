import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshRunning, performRollback, rollbackProblems } from './rollback-profile.mjs'

/** Build a directory that looks like a restorable profile backup. */
function makeBackup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-rollback-'))
  mkdirSync(join(dir, 'node_modules', 'dsh-memory-gate', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: { 'dsh-memory-gate': 'file:dsh-memory-gate-0.1.0.tgz' },
    dsh: { profile: { bundles: ['dsh-memory-gate'] } },
  }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(dir, 'node_modules', 'dsh-memory-gate', 'package.json'), JSON.stringify({ name: 'dsh-memory-gate', version: '0.1.0' }))
  writeFileSync(join(dir, 'node_modules', 'dsh-memory-gate', 'lib', 'index.js'), '// built\n')
  for (const [path, body] of Object.entries(overrides)) writeFileSync(join(dir, path), body)
  return dir
}

test('accepts a complete profile backup', () => {
  const backup = makeBackup()
  try {
    assert.deepEqual(rollbackProblems(backup, join(backup, '..', 'profile')), [])
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
})

test('rejects a missing backup directory', () => {
  const missing = join(tmpdir(), 'mg-rollback-does-not-exist')
  assert.match(rollbackProblems(missing, join(tmpdir(), 'p'))[0], /does not exist/)
})

test('rejects a backup that is the profile itself', () => {
  const backup = makeBackup()
  try {
    assert.match(rollbackProblems(backup, backup).join('\n'), /same directory/)
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
})

test('rejects a directory that is not a DSH profile', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mg-rollback-empty-'))
  try {
    const problems = rollbackProblems(empty, join(empty, '..', 'p'))
    assert.match(problems.join('\n'), /no package\.json/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('rejects a profile whose bundle list omits the plugin', () => {
  const backup = makeBackup({
    'package.json': JSON.stringify({
      dependencies: { 'dsh-memory-gate': 'file:x.tgz' },
      dsh: { profile: { bundles: ['something-else'] } },
    }),
  })
  try {
    const problems = rollbackProblems(backup, join(backup, '..', 'p')).join('\n')
    assert.match(problems, /does not list dsh-memory-gate/)
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
})

test('rejects a backup without the installed plugin or lockfile', () => {
  const backup = makeBackup()
  try {
    rmSync(join(backup, 'node_modules'), { recursive: true, force: true })
    rmSync(join(backup, 'pnpm-lock.yaml'))
    const problems = rollbackProblems(backup, join(backup, '..', 'p')).join('\n')
    assert.match(problems, /no pnpm-lock\.yaml/)
    assert.match(problems, /no installed plugin/)
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
})

test('restores the backup and keeps the replaced profile aside', () => {
  const backup = makeBackup()
  const profile = join(backup, '..', `mg-profile-${Date.now()}`)
  try {
    // A marker that must not survive the restore.
    mkdirSync(join(profile, 'node_modules', 'dsh-memory-gate', 'lib'), { recursive: true })
    writeFileSync(join(profile, 'stale.txt'), 'stale')
    writeFileSync(join(profile, 'node_modules', 'dsh-memory-gate', 'lib', 'index.js'), '// new\n')

    const moved = performRollback(backup, profile, 'test')
    assert.equal(moved, `${profile}.pre-rollback-test`)
    assert.equal(existsSync(join(profile, 'stale.txt')), false)
    assert.equal(readFileSync(join(profile, 'node_modules', 'dsh-memory-gate', 'lib', 'index.js'), 'utf8'), '// built\n')
    // The replaced tree is preserved, not deleted.
    assert.equal(readFileSync(join(moved, 'stale.txt'), 'utf8'), 'stale')
  } finally {
    rmSync(backup, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
    rmSync(`${profile}.pre-rollback-test`, { recursive: true, force: true })
  }
})

test('restores into a profile that does not exist yet', () => {
  const backup = makeBackup()
  const profile = join(backup, '..', `mg-fresh-${Date.now()}`)
  try {
    const moved = performRollback(backup, profile, 'test')
    assert.equal(moved, undefined)
    assert.equal(existsSync(join(profile, 'package.json')), true)
  } finally {
    rmSync(backup, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('rejects invalid JSON instead of throwing', () => {
  const backup = makeBackup({ 'package.json': '{ not json' })
  try {
    assert.match(rollbackProblems(backup, join(backup, '..', 'p')).join('\n'), /not valid JSON/)
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
})

test('dshRunning sees both the shell and a command-line runtime', () => {
  const shell = '"DeepSeek Harness.exe","43848","Console","1","204,944 K"'
  // The ohter shape: a `dsh` runtime running inside node.exe, no shell process.
  assert.equal(dshRunning({ list: () => shell, count: () => 0 }), true)
  assert.equal(dshRunning({ list: () => '', count: () => 3 }), true)
  assert.equal(dshRunning({ list: () => '', count: () => 0 }), false)
})

test('dshRunning treats an unusable probe as "not running"', () => {
  // A host without tasklist (or PowerShell) must not block an install forever.
  assert.equal(dshRunning({ list: () => { throw new Error('no tasklist') }, count: () => 0 }), false)
  assert.equal(dshRunning({ list: () => '', count: () => { throw new Error('no powershell') } }), false)
  assert.equal(dshRunning({ list: () => '', count: () => Number.NaN }), false)
})
