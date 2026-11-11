import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const gate = fileURLToPath(new URL('./release-gate.mjs', import.meta.url))
function runGate({ status = 200, body = { name: 'dsh-memory-header-gate', versions: {}, 'dist-tags': { latest: '0.0.9' } }, version = '0.1.0', tag = `v${version}` } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-gate-release-gate-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-memory-header-gate', version }))
    const output = join(root, 'output')
    writeFileSync(output, '')
    const mock = `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, {status:${status}})`
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, gate], {
      cwd: root, env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output }, encoding: 'utf8', timeout: 10000,
    })
    return { status: child.status, output: readFileSync(output, 'utf8'), stderr: child.stderr }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
test('real release entry accepts package 404 and writes stable outputs', () => {
  const result = runGate({ status: 404 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'dist-tag=latest\nprerelease=false\n')
})
test('real release entry rejects registry failures, malformed data and an existing version', () => {
  for (const input of [
    { status: 500 }, { body: {} },
    { body: { name: 'dsh-memory-header-gate', versions: { '0.1.0': {} }, 'dist-tags': {} } },
  ]) {
    const result = runGate(input)
    assert.notEqual(result.status, 0)
    assert.equal(result.output, '')
  }
})
test('real release entry refuses tag mismatch and latest rollback', () => {
  for (const input of [{ version: '0.0.8' }, { tag: 'v9.9.9' }]) {
    const result = runGate(input)
    assert.notEqual(result.status, 0)
    assert.equal(result.output, '')
  }
})
test('real release entry assigns prerelease output consistently', () => {
  const result = runGate({ version: '0.2.0-rc.1' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'dist-tag=next\nprerelease=true\n')
})
