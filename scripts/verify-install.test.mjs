// The post-install verifier must actually distinguish the two builds. Its
// whole purpose is answering "did the NEW build land?" when the version number
// stayed the same, so a check that passes on the OLD build is worse than none.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = join(import.meta.dirname, 'verify-install.mjs')
const libDir = join(import.meta.dirname, '..', 'lib')

/** A profile that looks like a completed install of the given halves. */
function makeProfile({ hostMarkers = true, clientMarkers = true, bundle = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mg-verify-'))
  const profile = join(root, 'profile')
  const installed = join(profile, 'node_modules', 'dsh-memory-header-gate')
  mkdirSync(join(installed, 'lib'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: { 'dsh-memory-header-gate': 'file:dsh-memory-header-gate-0.1.0.tgz' },
    dsh: { profile: { bundles: bundle ? ['dsh-memory-header-gate'] : [] } },
  }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'importers:\n  .:\n    dependencies:\n      "dsh-memory-header-gate@file:x": {}\n')
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-memory-header-gate', version: '0.1.0' }))
  // The real artifacts, optionally stripped back to the old build's shape.
  const host = hostMarkers
    ? 'trustedOrigins removeHeaderNames migratedAt name-reserved name-conflict name-duplicate'
    : 'const a = 1;'
  const client = clientMarkers
    ? 'window.__ModuleLoader__.load({id: "dsh-memory-header-gate"}) // issueHeaderNameReserved issueHeaderNameDuplicate issueNameConflict issueSaveBlockedByIdentity'
    : 'window.__ModuleLoader__.load({id: "dsh-memory-header-gate"})'
  writeFileSync(join(installed, 'lib', 'index.js'), host)
  writeFileSync(join(installed, 'lib', 'client.js'), client)
  return { root, profile }
}

/** Run the verifier, returning its exit code and output. */
function verify(profile, extra = []) {
  try {
    const out = execFileSync(process.execPath, [script, profile, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` }
  }
}

test('passes only when both halves carry the new markers', () => {
  const { root, profile } = makeProfile()
  try {
    const { code, out } = verify(profile, [`--storage=${join(root, 'storage')}`])
    assert.equal(code, 0, out)
    assert.match(out, /8\/8 checks passed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails on the old host half, naming what is missing', () => {
  const { root, profile } = makeProfile({ hostMarkers: false })
  try {
    const { code, out } = verify(profile, [`--storage=${join(root, 'storage')}`])
    assert.equal(code, 1)
    assert.match(out, /FAIL {2}host half is the new build/)
    assert.match(out, /missing trustedOrigins/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails on the old client half even though the wrapper looks identical', () => {
  // Regression guard: the module wrapper and id are byte-identical across both
  // builds, so a wrapper-only check silently passes on the build being replaced.
  const { root, profile } = makeProfile({ clientMarkers: false })
  try {
    const { code, out } = verify(profile, [`--storage=${join(root, 'storage')}`])
    assert.equal(code, 1)
    assert.match(out, /FAIL {2}client half is the new build/)
    assert.match(out, /missing issueHeaderNameReserved/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when the manifest does not register the bundle', () => {
  const { root, profile } = makeProfile({ bundle: false })
  try {
    const { code, out } = verify(profile, [`--storage=${join(root, 'storage')}`])
    assert.equal(code, 1)
    assert.match(out, /FAIL {2}manifest lists the bundle/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finds the pin store through the installed bundle, not the package name', () => {
  // The storage directory is the cordis row id (`memory-gate`), and it differs
  // from the package name on purpose. Resolving it by package name silently
  // looks in a directory that never exists, and "no pins yet" reads as PASS.
  const { root, profile } = makeProfile()
  const home = mkdtempSync(join(tmpdir(), 'mg-home-'))
  try {
    const store = join(home, 'storage', 'memory-gate')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'sessions.json'), JSON.stringify({ version: 1, sessions: { a: {}, b: {} } }))
    const out = execFileSync(process.execPath, [script, profile, `--storage=${store}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home },
    })
    assert.match(out, /pin store is readable — 2 pin\(s\)/, out)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('reports a missing profile instead of throwing', () => {
  const { code, out } = verify(join(tmpdir(), 'mg-verify-does-not-exist'), ['--storage=' + join(tmpdir(), 'mg-none')])
  assert.equal(code, 1)
  assert.match(out, /FAIL {2}profile is a DSH profile/)
})
