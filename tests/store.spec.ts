/**
 * The host-only storage layer: session-pin round trip, pruning, corruption
 * tolerance, the debounced flush, and the append-only decision log.
 *
 * Files are exercised in real temporary directories; only timers are faked
 * where the debounce is under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDecisionLog,
  createSessionStore,
  dshHome,
  flushDecisionLog,
  MAX_LOG_BYTES,
  MAX_SESSION_PINS,
  storeDir,
} from '../src/store.js'
import type { SessionPin } from '../src/gate.js'

/** Temporary roots created by one test, removed afterwards. */
const roots: string[] = []

/** A fresh temporary root. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-gate-store-'))
  roots.push(root)
  return root
}

/** One pin literal. */
function pin(overrides: Partial<SessionPin> = {}): SessionPin {
  return { identity: 'main', reason: 'attached', at: 1, provider: 'magpie', model: 'm1', ...overrides }
}

/** Read a JSON file. */
function readJSON(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dshHome / storeDir', () => {
  it('prefers $DSH_HOME when it is non-empty', () => {
    expect(dshHome({ DSH_HOME: '  /srv/dsh  ' })).toBe('/srv/dsh')
    expect(storeDir({ DSH_HOME: '/srv/dsh' })).toBe(join('/srv/dsh', 'storage', 'memory-gate'))
  })

  it('falls back to USERPROFILE, then HOME, appending .dsh', () => {
    expect(dshHome({ USERPROFILE: '/home/win' })).toBe(join('/home/win', '.dsh'))
    expect(dshHome({ HOME: '/home/nix' })).toBe(join('/home/nix', '.dsh'))
    expect(dshHome({ USERPROFILE: '/home/win', HOME: '/home/nix' })).toBe(join('/home/win', '.dsh'))
  })

  it('falls back to a relative .dsh when the environment names no home', () => {
    expect(dshHome({})).toBe('.dsh')
  })
})

describe('createSessionStore', () => {
  it('round-trips a pin through the JSON file', () => {
    const dir = tempRoot()
    const store = createSessionStore(dir)
    const stored = pin({ identity: null, reason: 'model-detached', at: 42, provider: 'p', model: 'm' })
    store.set('session-1', stored)
    expect(store.size()).toBe(1)
    store.flush()

    const file = join(dir, 'sessions.json')
    expect(readJSON(file)).toEqual({ version: 1, sessions: { 'session-1': stored } })

    const reloaded = createSessionStore(dir)
    expect(reloaded.size()).toBe(1)
    expect(reloaded.get('session-1')).toEqual(stored)
    expect(reloaded.get('other')).toBeUndefined()
  })

  it('deletes a pin and persists the deletion', () => {
    const dir = tempRoot()
    const store = createSessionStore(dir)
    store.set('a', pin())
    store.set('b', pin())
    store.flush()

    store.delete('a')
    expect(store.get('a')).toBeUndefined()
    expect(store.size()).toBe(1)
    store.flush()
    expect(readJSON(join(dir, 'sessions.json'))).toEqual({ version: 1, sessions: { b: pin() } })

    // Deleting a session that was never stored is a no-op.
    store.delete('missing')
    store.flush()
    expect(store.size()).toBe(1)
  })

  it('prunes to the configured bound, keeping the newest decisions', () => {
    const dir = tempRoot()
    const store = createSessionStore(dir, 2)
    store.set('old', pin({ at: 1 }))
    store.set('middle', pin({ at: 2 }))
    store.set('newest', pin({ at: 3 }))
    expect(store.size()).toBe(3)
    store.flush()

    expect(store.size()).toBe(2)
    expect([...storeKeys(dir)].sort()).toEqual(['middle', 'newest'])
    expect(createSessionStore(dir, 2).get('old')).toBeUndefined()
  })

  it('keeps the documented default bound', () => {
    expect(MAX_SESSION_PINS).toBe(2_000)
  })

  it('answers an empty store for a missing, corrupt or malformed file', () => {
    for (const body of [
      'not json at all',
      'null',
      '[]',
      '{"sessions":[1,2,3]}',
      '{"sessions":{"s1":{"identity":42}}}',
      '{"sessions":{"s1":"garbage"}}',
      '{"version":1}',
    ]) {
      const dir = tempRoot()
      writeFileSync(join(dir, 'sessions.json'), body)
      const store = createSessionStore(dir)
      expect(store.size()).toBe(0)
      expect(store.get('s1')).toBeUndefined()
    }
  })

  it('repairs a partially malformed pin instead of discarding the whole file', () => {
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { s1: { identity: null, reason: 42, at: 'nope', provider: null } },
    }))
    expect(createSessionStore(dir).get('s1')).toEqual({ identity: null, reason: 'unknown', at: 0, provider: '', model: '' })
  })

  it('flushes nothing when nothing changed, so a fresh home stays clean', () => {
    const dir = join(tempRoot(), 'nested')
    const store = createSessionStore(dir)
    store.flush()
    expect(existsSync(dir)).toBe(false)
  })

  it('writes the first pin of a run synchronously, so a crash cannot forget it', () => {
    const dir = join(tempRoot(), 'nested')
    const store = createSessionStore(dir)
    store.set('s1', pin())
    store.touch()
    // No timer advance: the first pin must already be on disk.
    expect(existsSync(join(dir, 'sessions.json'))).toBe(true)
    expect(readJSON(join(dir, 'sessions.json')))
      .toEqual({ version: 1, sessions: { s1: pin() } })
  })

  it('debounces later pins until the next flush', () => {
    vi.useFakeTimers()
    const dir = tempRoot()
    const store = createSessionStore(dir)
    store.set('first', pin({ at: 1 }))
    store.touch()
    expect(existsSync(join(dir, 'sessions.json'))).toBe(true)

    store.set('second', pin({ at: 2 }))
    store.touch()
    expect(readJSON(join(dir, 'sessions.json'))).toEqual({ version: 1, sessions: { first: pin({ at: 1 }) } })
    vi.advanceTimersByTime(999)
    expect(readJSON(join(dir, 'sessions.json'))).toEqual({ version: 1, sessions: { first: pin({ at: 1 }) } })
    vi.advanceTimersByTime(1)
    expect(readJSON(join(dir, 'sessions.json')))
      .toEqual({ version: 1, sessions: { first: pin({ at: 1 }), second: pin({ at: 2 }) } })

    // A manual flush before the timer fires writes both immediately.
    store.set('third', pin({ at: 3 }))
    store.touch()
    store.flush()
    expect(Object.keys((readJSON(join(dir, 'sessions.json')) as { sessions: Record<string, unknown> }).sessions))
      .toEqual(['first', 'second', 'third'])
  })
})

/** The session ids of one sessions.json. */
function* storeKeys(dir: string): Generator<string> {
  const parsed = readJSON(join(dir, 'sessions.json')) as { sessions?: Record<string, unknown> }
  yield* Object.keys(parsed.sessions ?? {})
}

describe('appendDecisionLog', () => {
  it('creates its directory and file when the home is fresh', async () => {
    // Regression: on a fresh install this plugin writes its first decision
    // before any session flush has created the directory; a missing directory
    // used to turn into an ENOENT warning and no log at all.
    const dir = join(tempRoot(), 'storage', 'memory-gate')
    appendDecisionLog(dir, '{"kind":"attach"}')
    await vi.waitFor(() => {
      const body = existsSync(join(dir, 'decisions.jsonl')) ? readFileSync(join(dir, 'decisions.jsonl'), 'utf8') : ''
      expect(body).toBe('{"kind":"attach"}\n')
    })
  })

  it('appends one line per decision, in call order', async () => {
    const dir = tempRoot()
    mkdirSync(dir, { recursive: true })
    const body = join(dir, 'decisions.jsonl')
    appendDecisionLog(dir, 'first')
    // Each append is asynchronous; awaiting the previous line keeps the
    // assertion about order rather than about a race between two writers.
    await vi.waitFor(() => { expect(existsSync(body) && readFileSync(body, 'utf8')).toBe('first\n') })
    appendDecisionLog(dir, 'second')
    await vi.waitFor(() => { expect(readFileSync(body, 'utf8')).toBe('first\nsecond\n') })
  })

  it('rotates an oversized log to .1 before appending', async () => {
    const dir = tempRoot()
    const file = join(dir, 'decisions.jsonl')
    writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES))
    appendDecisionLog(dir, 'after-rotation')
    await vi.waitFor(() => {
      expect(existsSync(file) && readFileSync(file, 'utf8').includes('after-rotation')).toBe(true)
    })
    expect(statSync(`${file}.1`).size).toBe(MAX_LOG_BYTES)
    expect(readFileSync(file, 'utf8')).toBe('after-rotation\n')
  })

  it('orders a batch of appends by call order, not by completion order', async () => {
    // Regression: appends used to race. Each one stat'ed and appended on its
    // own, so a later line could land first — visible as a `pinned` line above
    // the `attached` line that caused it.
    const dir = tempRoot()
    appendDecisionLog(dir, 'one')
    appendDecisionLog(dir, 'two')
    appendDecisionLog(dir, 'three')
    await flushDecisionLog(dir)
    expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('drops a queued line quietly when the tree disappears mid-flight', async () => {
    // Uninstall and temp cleanup both remove the directory under a queued
    // append; that is legitimate, so it must not warn or throw.
    const dir = join(tempRoot(), 'gone')
    appendDecisionLog(dir, 'orphan')
    rmSync(dir, { recursive: true, force: true })
    await expect(flushDecisionLog(dir)).resolves.toBeUndefined()
  })

  it('resolves its flush immediately when nothing was ever queued', async () => {
    await expect(flushDecisionLog(join(tempRoot(), 'never'))).resolves.toBeUndefined()
  })
})