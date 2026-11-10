import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { readCompatibility } from './ci-compatibility.mjs'

const script = name => fileURLToPath(new URL(name, import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'memory-gate-ci-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/@deepseek-ai/dsh-authorization': { version: '0.2.1-rc.3' },
    } }))
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const run = (root, name, args, env = {}) => spawnSync(process.execPath, [script(name), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env }, timeout: 10000,
})

test('compatibility matrix selects only DSH, Cordis and Schemastery development dependencies', () => fixture(root => {
  const matrix = run(root, 'ci-compatibility.mjs', ['matrix'])
  assert.equal(matrix.status, 0, matrix.stderr)
  assert.deepEqual(JSON.parse(matrix.stdout), { 'dsh-version': Object.keys(manifest.dshCompatibility) })
  for (const version of Object.keys(manifest.dshCompatibility)) {
    const result = run(root, 'ci-compatibility.mjs', ['select', version])
    assert.equal(result.status, 0, result.stderr)
    const selected = JSON.parse(readFileSync(join(root, 'package.json')))
    for (const [name, value] of Object.entries(manifest.devDependencies)) {
      const expected = name.startsWith('@deepseek-ai/dsh-') ? version
        : name === '@deepseek-ai/cordis' ? manifest.dshCompatibility[version].cordis
          : name === '@deepseek-ai/schemastery' ? manifest.dshCompatibility[version].schemastery : value
      assert.equal(selected.devDependencies[name], expected)
    }
    assert.deepEqual(selected.peerDependencies, manifest.peerDependencies)
    assert.equal(selected.overrides['@deepseek-ai/dsh-authorization'], version)
    assert.equal(selected.overrides['@deepseek-ai/dsh-invariants'], version)
    assert.equal(selected.overrides['@deepseek-ai/cordis'], manifest.dshCompatibility[version].cordis)
    assert.equal(selected.overrides['@deepseek-ai/schemastery'], manifest.dshCompatibility[version].schemastery)
    assert.equal(run(root, 'ci-compatibility.mjs', ['select', version]).stdout.trim(), 'changed=false')
  }
  assert.notEqual(run(root, 'ci-compatibility.mjs', ['select', 'latest']).status, 0)
}))

test('compatibility reader rejects empty, ranged and malformed metadata', () => fixture(root => {
  for (const entries of [undefined, {}, [], { latest: { cordis: '4.0.5', schemastery: '3.18.5' } },
    { '0.2.0-rc.1': { cordis: '*', schemastery: '3.18.4' } },
    { '0.2.0-rc.1': { cordis: '4.0.4' } }]) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dshCompatibility: entries }))
    assert.throws(() => readCompatibility(join(root, 'package.json')))
  }
}))

test('verification records failures, continues independent checks and summarizes both Node legs', { skip: process.platform === 'win32' }, () => fixture(root => {
  mkdirSync(join(root, 'bin'))
  const npm = join(root, 'bin/npm')
  writeFileSync(npm, `#!${process.execPath}\nprocess.exit(process.argv.includes(process.env.FAIL_STEP) ? 1 : 0)\n`)
  chmodSync(npm, 0o755)
  const major = process.versions.node.split('.')[0]
  const supported = Object.keys(readCompatibility().entries)[0]
  const env = { PATH: `${root}/bin:${process.env.PATH}`, DSH_TEST_VERSION: supported, FAIL_STEP: 'typecheck' }
  const result = run(root, 'ci-verify.mjs', ['verify', major], env)
  assert.equal(result.status, 1, result.stderr)
  let report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.equal(report.steps.find(s => s.name === 'typecheck').status, 'failed')
  assert.equal(report.steps.find(s => s.name === 'package').status, 'passed')
  const summary = run(root, 'ci-verify.mjs', ['summary'], env)
  assert.equal(summary.status, 0, summary.stderr)
  assert.match(summary.stdout, /failed/)
  assert.match(summary.stdout, /not run/)
  const installFailure = run(root, 'ci-verify.mjs', ['verify', major], { ...env, FAIL_STEP: 'ci' })
  assert.equal(installFailure.status, 1)
  report = JSON.parse(readFileSync(join(root, `artifacts/ci/node-${major}.json`)))
  assert.ok(report.steps.slice(1).every(s => s.status === 'skipped'))
}))

test('workflow pins the npm resolver before both Node verification legs', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.verify.steps
  const at = id => steps.findIndex(step => step.id === id)
  for (const id of ['npm22', 'npm24']) {
    const index = at(id)
    assert.ok(index >= 0, `${id} must pin npm before dependency resolution`)
    assert.equal(steps[index].run, 'npm install --global npm@11.19.0')
  }
  assert.ok(at('setup22') < at('npm22') && at('npm22') < at('cohort'))
  assert.ok(at('setup24') < at('npm24') && at('npm24') < at('verify24'))
})

test('cohort selection resolves a replacement DSH lock without the committed lock', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const run = workflow.jobs.verify.steps.find(step => step.id === 'cohort').run
  const moveTree = run.indexOf('mv node_modules artifacts/ci/committed-node_modules')
  const moveLock = run.indexOf('mv package-lock.json artifacts/ci/committed-package-lock.json')
  const resolve = run.indexOf('npm install --package-lock-only')
  assert.ok(moveTree >= 0, 'committed node_modules must be moved aside')
  assert.ok(moveLock > moveTree, 'committed lockfile must also be moved aside')
  assert.ok(resolve > moveLock, 'replacement resolution must start after the old lockfile is removed')
})

test('workflow isolates PR validation from tag-only publishing with no artifact uploads', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.deepEqual(workflow.on, { pull_request: null, push: { tags: ['v*'] } })
  assert.equal(workflow.jobs.publish.needs, undefined)
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write')
  const steps = workflow.jobs.verify.steps
  assert.match(steps.find(s => s.id === 'verify24').if, /!cancelled\(\)/)
  assert.doesNotMatch(steps.find(s => s.id === 'verify24').if, /verify22/)
  assert.equal(steps.find(s => s.name === 'Test summary').if, 'always()')
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.every(s => !s.uses?.includes('artifact')))
  }
  const publishCommands = workflow.jobs.publish.steps.map(s => s.run ?? '').join('\n')
  assert.doesNotMatch(publishCommands, /npm (test|run (check|test|pack:check))/)
  assert.match(publishCommands, /npm publish --ignore-scripts/)
  assert.match(publishCommands, /npm ci --ignore-scripts --legacy-peer-deps=false/)
})
