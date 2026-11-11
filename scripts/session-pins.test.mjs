// Behaviour of the pin-maintenance CLI on a scratch directory. The live guard
// is bypassed with --force here because these fixtures are never loaded by a
// running plugin; the live path is exercised by hand in DEPLOY.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = join(import.meta.dirname, 'session-pins.mjs')

/** A scratch store holding the given pins. */
function store(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'mg-pins-'))
  const dir = join(root, 'storage', 'memory-gate')
  mkdirSync(dir, { recursive: true })
  if (sessions !== undefined) writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }))
  return { dir, file: join(dir, 'sessions.json') }
}

/** Run the CLI against one store, returning stdout. */
function run(dir, ...args) {
  return execFileSync(process.execPath, [script, `--dir=${dir}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const attached = { identity: 'tdai-main', reason: 'attached', at: 1 }
const detached = { identity: null, reason: 'no-default-identity', at: 2 }

test('lists pins with their attachment state', () => {
  const { dir } = store({ 's-on': attached, 's-off': detached })
  const out = run(dir)
  assert.match(out, /2 pin\(s\), 1 detached, 1 attached/)
  assert.match(out, /s-on {2}tdai-main/)
  assert.match(out, /s-off {2}\(detached\)/)
  // The hint is the whole point: a detached session never recovers by itself.
  assert.match(out, /--clear-detached/)
})

test('says so when nothing is pinned yet, instead of failing', () => {
  const { dir } = store(undefined)
  assert.match(run(dir), /no pin file/)
})

test('drops only the detached pins and backs the file up first', () => {
  const { dir, file } = store({ 's-on': attached, 's-off': detached, 's-other': { ...detached, reason: 'identity-missing' } })
  run(dir, '--clear-detached', '--yes', '--force')

  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(written, { version: 1, sessions: { 's-on': attached } })
  assert.equal(readdirSync(dir).filter(name => name.startsWith('sessions.json.bak-pins-')).length, 1)
})

test('clears one named session and leaves the rest alone', () => {
  const { dir, file } = store({ 's-a': attached, 's-b': { ...attached, at: 3 } })
  run(dir, '--clear', 's-a', '--yes', '--force')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions), ['s-b'])
})

test('writes nothing when the target is not pinned', () => {
  const { dir, file } = store({ 's-a': attached })
  const before = readFileSync(file, 'utf8')
  assert.match(run(dir, '--clear', 'nope', '--yes', '--force'), /not pinned/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(readdirSync(dir).filter(name => name.includes('.bak-pins-')).length, 0)
})

test('refuses to clear anything without a target', () => {
  const { dir, file } = store({ 's-a': attached })
  const before = readFileSync(file, 'utf8')
  assert.throws(() => run(dir, '--clear', '--yes', '--force'), /--clear needs a session id/)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('leaves no temp file behind and keeps the file parseable', () => {
  const { dir, file } = store({ 's-off': detached })
  run(dir, '--clear-detached', '--yes', '--force')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, sessions: {} })
  assert.equal(readdirSync(dir).filter(name => name.includes('.tmp-')).length, 0)
  assert.ok(existsSync(file))
})

test.after(() => {
  // Scratch dirs live under the OS temp root; nothing to clean individually.
})
