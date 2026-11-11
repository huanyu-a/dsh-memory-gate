import { test } from 'node:test'
import assert from 'node:assert/strict'
import YAML from 'yaml'
import { pruneMemoryGateLock } from './profile-lock.mjs'

for (const quote of ['', "'"]) {
  test(`prunes complete importer/package/snapshot blocks (quote=${quote})`, () => {
    const input = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      unrelated:
        specifier: 1.0.0
        version: 1.0.0
      dsh-memory-gate:
        specifier: file:dsh-memory-gate-0.1.0.tgz
        version: file:dsh-memory-gate-0.1.0.tgz
packages:
  unrelated@1.0.0:
    resolution: {integrity: safe}
  ${quote}dsh-memory-gate@file:dsh-memory-gate-0.1.0.tgz${quote}:
    resolution: {integrity: stale}
    peerDependencies:
      react: '*'
  following@1.0.0:
    resolution: {integrity: following}
snapshots:
  ${quote}dsh-memory-gate@file:dsh-memory-gate-0.1.0.tgz(react@18.2.0)${quote}:
    dependencies:
      react: 18.2.0
  unrelated@1.0.0: {}
`
    const { text, removed } = pruneMemoryGateLock(input)
    const result = YAML.parse(text)
    assert.equal(removed, 3)
    assert.doesNotMatch(text, /dsh-memory-gate|stale/)
    assert.deepEqual(result.packages['unrelated@1.0.0'], { resolution: { integrity: 'safe' } })
    assert.deepEqual(result.packages['following@1.0.0'], { resolution: { integrity: 'following' } })
    assert.equal(result.importers['.'].dependencies.unrelated.version, '1.0.0')
    assert.deepEqual(result.snapshots, { 'unrelated@1.0.0': {} })
  })
}

test('handles inline mappings, quoted importer keys and trailing comments', () => {
  const input = `importers:
  .:
    dependencies:
      'dsh-memory-gate': {specifier: file:plugin.tgz, version: file:plugin.tgz}
packages:
  'dsh-memory-gate@file:plugin.tgz': {resolution: {integrity: stale}}
snapshots:
  dsh-memory-gate@file:plugin.tgz: {} # inline
  unrelated: {}
`
  const result = pruneMemoryGateLock(input)
  assert.equal(result.removed, 3)
  assert.doesNotMatch(result.text, /dsh-memory-gate/)
  assert.deepEqual(YAML.parse(result.text).snapshots, { unrelated: {} })
})

test('rejects malformed or duplicate YAML before transformation', () => {
  assert.throws(() => pruneMemoryGateLock('packages:\n  duplicate: 1\n  duplicate: 2\n'), /invalid profile lockfile/)
})

test('missing records require an explicitly new installation', () => {
  const text = "lockfileVersion: '9.0'\nimporters: {}\n"
  assert.throws(() => pruneMemoryGateLock(text), /cannot force a re-extract safely/)
  assert.equal(pruneMemoryGateLock(text, { allowMissing: true }).text, text)
})
