import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releasePolicy } from './release-policy.mjs'
test('stable first release and monotonically increasing latest', () => {
  assert.deepEqual(releasePolicy('0.1.0', 'v0.1.0'), { distTag: 'latest', prerelease: false })
  assert.equal(releasePolicy('0.2.0', 'v0.2.0', '0.1.9').distTag, 'latest')
  for (const latest of ['0.1.0', '0.2.0', 'invalid']) assert.throws(() => releasePolicy('0.1.0', 'v0.1.0', latest))
})
test('prereleases always use next; tags must exactly match', () => {
  assert.deepEqual(releasePolicy('0.2.0-rc.1', 'v0.2.0-rc.1', '0.3.0'), { distTag: 'next', prerelease: true })
  assert.throws(() => releasePolicy('0.1.0', 'v0.2.0'))
  assert.throws(() => releasePolicy('0.1.0', '0.1.0'))
  assert.throws(() => releasePolicy('not-semver', 'vnot-semver'))
})
