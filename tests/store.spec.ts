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
  readdirSync,
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

  it('is part of the built bundle so the maintenance CLI can import it', async () => {
    // scripts/session-pins.mjs resolves the storage directory through this
    // export instead of keeping a copy of the rule; losing the export would
    // leave the CLI silently looking in the wrong place.
    const bundle = await import('../lib/index.js')
    expect(bundle.storeDir).toBeTypeOf('function')
    expect(bundle.storeDir({ DSH_HOME: '/srv/dsh' })).toBe(join('/srv/dsh', 'storage', 'memory-gate'))
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

  it('round-trips the immutable attachment snapshot and its migration marker', () => {
    const dir = tempRoot()
    const store = createSessionStore(dir)
    const snapshot = {
      identity: { id: 'main', team: 'team-a', agent: 'a', task: '', headers: [{ name: 'X-Tenant', value: 'acme' }] },
      headerNames: { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' },
      sessionHeader: false,
    }
    const stored = pin({ snapshot, migratedAt: 77 })
    store.set('session-1', stored)
    store.flush()

    const reloaded = createSessionStore(dir)
    expect(reloaded.get('session-1')).toEqual(stored)
    expect(reloaded.get('session-1')?.snapshot?.identity.headers).toEqual([{ name: 'X-Tenant', value: 'acme' }])
  })

  it('drops a partially invalid snapshot whole rather than attaching half an identity', () => {
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        'no-id': { ...pin(), snapshot: { identity: { team: 't' }, headerNames: {}, sessionHeader: true } },
        'bad-rows': { ...pin(), snapshot: {
          identity: { id: 'main', headers: ['x'] }, headerNames: {}, sessionHeader: true,
        } },
        legacy: pin(),
      },
    }))
    const store = createSessionStore(dir)
    expect(store.get('no-id')).toEqual(pin())
    expect(store.get('bad-rows')).toEqual(pin())
    // A legacy pin stays id-only: the gate migrates it, not the loader.
    expect(store.get('legacy')).toEqual(pin())
  })

  it('drops a snapshot whose rows the stricter header rules now reject', () => {
    // Upgrade note: a row that overrides a configured header name, or repeats a
    // name, was once accepted. Such a pin is now dropped, so the session falls
    // back to a fresh decision at the next request instead of replaying a
    // snapshot that could overwrite the identity it claims to pin.
    const dir = tempRoot()
    const names = { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' }
    const snapshot = (headers: unknown[]) => ({
      identity: { id: 'main', team: 't', agent: 'a', task: '', headers },
      headerNames: names, sessionHeader: true,
    })
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        'ok': { ...pin({ identity: 'main' }), snapshot: snapshot([{ name: 'x-extra', value: 'v' }]), migratedAt: 1 },
        'overrides-team': { ...pin({ identity: 'main' }), snapshot: snapshot([{ name: 'X-Team-Id', value: 'v' }]), migratedAt: 1 },
        'repeats-name': { ...pin({ identity: 'main' }), snapshot: snapshot([{ name: 'x-a', value: '1' }, { name: 'X-A', value: '2' }]), migratedAt: 1 },
      },
    }))
    const store = createSessionStore(dir)
    expect(store.get('ok')?.snapshot).toBeDefined()
    // Dropped to an id-only pin: the session re-decides instead of replaying it.
    expect(store.get('overrides-team')?.snapshot).toBeUndefined()
    expect(store.get('repeats-name')?.snapshot).toBeUndefined()
  })

  it('leaves no temp file behind when a write fails', () => {
    // flush() writes a .tmp-<pid> file then renames it. When the rename fails
    // the temp file used to survive, one per failed attempt, for the life of
    // the process.
    const dir = tempRoot()
    mkdirSync(dir, { recursive: true })
    // A directory at the destination makes rename fail without losing data.
    mkdirSync(join(dir, 'sessions.json'))
    const store = createSessionStore(dir)
    store.set('session-1', pin({ identity: 'main' }))
    store.flush()
    const leftovers = readdirSync(dir).filter(name => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('ignores a snapshot that names a different identity than the pin', () => {
    // A hand-edited file must not let a pin attach an identity it never chose.
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        'edited': {
          ...pin({ identity: 'main' }),
          snapshot: {
            identity: { id: 'intruder', team: 'evil', agent: '', task: '', headers: [] },
            headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
            sessionHeader: true,
          },
        },
        'cased': {
          ...pin({ identity: 'Main' }),
          snapshot: {
            identity: { id: 'main', team: 't', agent: '', task: '', headers: [] },
            headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
            sessionHeader: true,
          },
        },
      },
    }))
    const store = createSessionStore(dir)
    expect(store.get('edited')?.snapshot).toBeUndefined()
    // The gate compares ids case-insensitively, and so does the loader.
    expect(store.get('cased')?.snapshot?.identity.id).toBe('main')
  })

  it('rejects a snapshot with any missing or wrongly typed field', () => {
    // Every field must round-trip exactly: a coerced default would replay a
    // header set the session never sent.
    const dir = tempRoot()
    const good = {
      identity: { id: 'main', team: 't', agent: '', task: '', headers: [] },
      headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
      sessionHeader: true,
    }
    const variants: Record<string, unknown> = {
      'no-session-header': { ...good, sessionHeader: 'yes' },
      'no-task-name': { ...good, headerNames: { team: 'x-team-id', agent: 'x-agent-id' } },
      'numeric-team': { ...good, identity: { ...good.identity, team: 42 } },
      'no-headers-row': { ...good, identity: { id: 'main', team: 't' } },
      'bad-row-value': { ...good, identity: { ...good.identity, headers: [{ name: 'X', value: 1 }] } },
    }
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(Object.entries(variants).map(([key, snapshot]) => [key, { ...pin(), snapshot }])),
    }))
    const store = createSessionStore(dir)
    for (const key of Object.keys(variants)) expect(store.get(key)).toEqual(pin())
  })

  it('rejects a snapshot whose header names break the settings write rules', () => {
    // A hand-edited file must not let a pinned session key the conversation
    // through the reserved session header, lose a triple to a duplicate, or
    // send an empty header name.
    const dir = tempRoot()
    const snapshot = (names: Record<string, string>, headers: Array<{ name: string, value: string }> = []) => ({
      identity: { id: 'main', team: 't', agent: 'a', task: '', headers },
      headerNames: names,
      sessionHeader: false,
    })
    const reserved = { team: 'x-deepseek-harness-session-id', agent: 'x-agent-id', task: 'x-task-id' }
    const duplicate = { team: 'X-Id', agent: 'x-id', task: 'x-task-id' }
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        reserved: { ...pin(), snapshot: snapshot(reserved) },
        duplicate: { ...pin(), snapshot: snapshot(duplicate) },
        'empty-row-with-value': { ...pin(), snapshot: snapshot({ team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' }, [{ name: '', value: 'v' }]) },
        'teamless': { ...pin(), snapshot: { ...snapshot({ team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' }), identity: { id: 'main', team: '  ', agent: '', task: '', headers: [] } } },
        valid: { ...pin(), snapshot: snapshot({ team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' }) },
      },
    }))
    const store = createSessionStore(dir)
    for (const key of ['reserved', 'duplicate', 'empty-row-with-value', 'teamless']) expect(store.get(key)).toEqual(pin())
    expect(store.get('valid')).toMatchObject({ snapshot: { headerNames: { team: 'x-team-id' } } })
  })

  it('drops a migration marker that has no usable snapshot with it', () => {
    // A marker without a snapshot would claim the pin is frozen while it still
    // tracks live configuration; the gate must be free to migrate it again.
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { incoherent: { ...pin(), migratedAt: 555, snapshot: { identity: { id: 'main' } } } },
    }))
    expect(createSessionStore(dir).get('incoherent')).toEqual(pin())
  })

  it('round-trips a detached pin’s removal names and drops unusable ones', () => {
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        good: { ...pin({ identity: null }), removeHeaderNames: { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' } },
        'bad-name': { ...pin({ identity: null }), removeHeaderNames: { team: 'bad name', agent: 'X-Agent', task: 'X-Task' } },
        'on-attach': { ...pin(), removeHeaderNames: { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' } },
      },
    }))
    const store = createSessionStore(dir)
    expect(store.get('good')?.removeHeaderNames).toEqual({ team: 'X-Team', agent: 'X-Agent', task: 'X-Task' })
    // Only deletion is affected, so an unusable name is dropped, not the pin.
    expect(store.get('bad-name')).toEqual(pin({ identity: null }))
    // A pin that could not freeze its values still remembers the names, so a
    // later rename can clean them up; an unusable triple is dropped instead.
    expect(store.get('on-attach')?.removeHeaderNames).toEqual({ team: 'X-Team', agent: 'X-Agent', task: 'X-Task' })
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

  it('does not evict a legacy pin in the same flush that migrates it', () => {
    // `at` stays at the original decision time, so eviction must order by the
    // later of at/migratedAt — otherwise the migration work is discarded at once.
    const dir = tempRoot()
    const store = createSessionStore(dir, 2)
    store.set('migrated', pin({ at: 1, migratedAt: 99 }))
    store.set('plain', pin({ at: 2 }))
    store.set('newest', pin({ at: 3 }))
    store.flush()

    expect([...storeKeys(dir)].sort()).toEqual(['migrated', 'newest'])
  })

  it('re-pins a session after deletion and drops an empty identity id on load', () => {
    const dir = tempRoot()
    const store = createSessionStore(dir)
    store.set('revived', pin({ at: 1 }))
    store.flush()
    store.delete('revived')
    store.flush()
    expect(store.get('revived')).toBeUndefined()

    store.set('revived', pin({ at: 5 }))
    store.flush()
    // The file keeps exactly the re-pinned session, with no leftover fields.
    expect(readJSON(join(dir, 'sessions.json'))).toEqual({ version: 1, sessions: { revived: pin({ at: 5 }) } })

    // An empty id could never match an identity, so the record is dropped
    // instead of pinning the session to a permanent "identity missing" detach.
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { blank: { ...pin(), identity: '   ' } },
    }))
    expect(createSessionStore(dir).get('blank')).toBeUndefined()
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

  it('keeps a copy of an unreadable pin file before overwriting it', () => {
    // A corrupt file is the one moment a rewrite must not be silent: the next
    // flush would otherwise erase every session it failed to parse.
    const dir = tempRoot()
    writeFileSync(join(dir, 'sessions.json'), 'not json at all')

    const store = createSessionStore(dir)
    expect(store.size()).toBe(0)

    const backups = readdirSync(dir).filter(name => name.startsWith('sessions.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('not json at all')

    store.set('fresh', pin())
    store.flush()
    expect(createSessionStore(dir).get('fresh')).toEqual(pin())
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