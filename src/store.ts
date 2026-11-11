/**
 * Durable session pins and the append-only decision log. Host-only (Node fs).
 * Every failure degrades to "decide fresh" rather than a broken dispatch — the
 * gate is an optimisation of the memory chain, never a hard dependency of a
 * model call.
 *
 * Files live beside the rest of the harness's plugin-owned storage:
 *   <dshHome>/storage/memory-gate/sessions.json    (bounded session pins)
 *   <dshHome>/storage/memory-gate/decisions.jsonl  (one line per decision)
 *
 * Loading is synchronous (bounded by {@link MAX_SESSION_PINS} entries; each
 * carries a full identity snapshot, so plan for a few MiB, not a few hundred
 * KB) so the first request of a restarted session already sees its pin; writes
 * are debounced off the request path, because a model call must never wait on
 * this plugin's disk.
 *
 * @module dsh-memory-gate/store
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { appendFile as appendFileAsync, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { headerNamesIssue, pinnedValuesIssue } from './identities.js'
import type { HeaderNames } from './identities.js'
import type { PinSnapshot, SessionPin } from './gate.js'

/** How many session pins to retain (newest first); older pins fall out. */
export const MAX_SESSION_PINS = 2_000

/** Rotate the decision log once it exceeds this size. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Storage root resolution: `$DSH_HOME` when set, else `~/.dsh`, like the harness itself. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DSH_HOME']
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  const home = env['USERPROFILE'] ?? env['HOME']
  if (typeof home === 'string' && home.length > 0) return join(home, '.dsh')
  return '.dsh'
}

/** The directory this plugin owns. */
export function storeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'storage', 'memory-gate')
}

/** A bounded, debounced map of session pins backed by one JSON file. */
export interface SessionStore {
  /** The pin of one session, if any. */
  get(sessionId: string): SessionPin | undefined
  /** Record (or replace) one session's pin. */
  set(sessionId: string, pin: SessionPin): void
  /**
   * Drop one session's pin. Nothing in the plugin calls it today: a reused
   * session id therefore keeps its pin, and a detach pin stays detached.
   */
  delete(sessionId: string): void
  /** Number of retained pins. */
  size(): number
  /** Schedule a flush of pending changes (no-op when nothing changed). */
  touch(): void
  /** Flush pending changes now (plugin teardown / tests). */
  flush(): void
}

/**
 * The header names a detached pin keeps deleting, or undefined when they are
 * unusable. They only ever feed `headers.delete`, so unusable values are
 * dropped rather than invalidating the whole pin.
 */
function removalNames(value: unknown): HeaderNames | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const names = { team: record['team'], agent: record['agent'], task: record['task'] }
  if (!Object.values(names).every(name => typeof name === 'string')) return undefined
  if (headerNamesIssue(names as HeaderNames) !== undefined) return undefined
  return names as HeaderNames
}

/**
 * Coerce a persisted record into a pin, or undefined when it cannot be trusted.
 */
function pinFromUnknown(value: unknown): SessionPin | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const identity = record['identity']
  if (identity !== null && typeof identity !== 'string') return undefined
  // An empty id matches no identity, so keeping it would strand the session on
  // 'pinned-identity-missing' forever; drop the record and let the gate re-decide.
  if (identity !== null && identity.trim().length === 0) return undefined
  const snapshot = replayableSnapshot(record['snapshot'])
  const removal = removalNames(record['removeHeaderNames'])
  // A migration marker without a usable snapshot is incoherent: the record
  // would claim to be frozen while still tracking live configuration. Drop the
  // marker so the gate migrates it again from a real configuration read.
  return {
    identity,
    reason: typeof record['reason'] === 'string' ? record['reason'] : 'unknown',
    at: typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : 0,
    provider: typeof record['provider'] === 'string' ? record['provider'] : '',
    model: typeof record['model'] === 'string' ? record['model'] : '',
    ...removal === undefined ? {} : { removeHeaderNames: removal },
    // A snapshot may only describe the identity the pin names. A hand-edited
    // file that disagrees falls back to the legacy id-only shape, so the gate
    // re-derives the identity instead of attaching one the pin never chose.
    ...snapshot === undefined || identity === null || !sameIdentityId(identity, snapshot.identity.id)
      ? {}
      : {
        snapshot,
        ...typeof record['migratedAt'] === 'number' && Number.isFinite(record['migratedAt'])
          ? { migratedAt: record['migratedAt'] }
          : {},
      },
  }
}

/** Identity ids compare like the gate compares them: trimmed, case-insensitive. */
function sameIdentityId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Coerce a persisted snapshot. Every field is required and must hold exactly
 * the shape the gate wrote: a partly readable snapshot is rejected whole,
 * because attaching a subset would send a header set the session never pinned
 * (and an empty header name silently drops one of the identity triple).
 */
function snapshotFromUnknown(value: unknown): PinSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const identity = record['identity']
  const names = record['headerNames']
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return undefined
  if (typeof names !== 'object' || names === null || Array.isArray(names)) return undefined
  if (typeof record['sessionHeader'] !== 'boolean') return undefined
  const rawIdentity = identity as Record<string, unknown>
  const rawNames = names as Record<string, unknown>
  const strings = ['id', 'team', 'agent', 'task'] as const
  for (const field of strings) {
    if (typeof rawIdentity[field] !== 'string') return undefined
  }
  for (const field of ['team', 'agent', 'task'] as const) {
    if (typeof rawNames[field] !== 'string') return undefined
  }
  const rawHeaders = rawIdentity['headers']
  if (!Array.isArray(rawHeaders)) return undefined
  const headers: Array<{ name: string, value: string }> = []
  for (const row of rawHeaders) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
    const entry = row as Record<string, unknown>
    if (typeof entry['name'] !== 'string' || typeof entry['value'] !== 'string') return undefined
    headers.push({ name: entry['name'], value: entry['value'] })
  }
  return {
    identity: {
      id: rawIdentity['id'] as string,
      team: rawIdentity['team'] as string,
      agent: rawIdentity['agent'] as string,
      task: rawIdentity['task'] as string,
      headers,
    },
    headerNames: {
      team: rawNames['team'] as string,
      agent: rawNames['agent'] as string,
      task: rawNames['task'] as string,
    },
    sessionHeader: record['sessionHeader'],
  }
}

/**
 * A snapshot is only replayable when its values still satisfy the settings
 * write rules: a hand-edited file must not smuggle in a reserved or duplicate
 * header name, an empty header row, or an unrepresentable value.
 */
function replayableSnapshot(value: unknown): PinSnapshot | undefined {
  const snapshot = snapshotFromUnknown(value)
  if (snapshot === undefined) return undefined
  return pinnedValuesIssue(snapshot.identity, snapshot.headerNames) === undefined ? snapshot : undefined
}

/**
 * Create the store, loading any previous pins.
 * @param dir - directory to hold the files.
 * @param maxEntries - pin-count bound.
 */
export function createSessionStore(dir: string, maxEntries = MAX_SESSION_PINS): SessionStore {
  const file = join(dir, 'sessions.json')
  const pins = new Map<string, SessionPin>()
  let dirty = false
  let wroteOnce = false
  let timer: NodeJS.Timeout | undefined

  /** The last time a pin was decided or migrated (its recency). */
  const recencyOf = (pin: SessionPin): number => Math.max(pin.at, pin.migratedAt ?? 0)

  const prune = (): void => {
    if (pins.size <= maxEntries) return
    // Order by the last decision *or* the one-time migration: a freshly
    // migrated legacy pin must not be the first victim of the same flush.
    const ordered = [...pins.entries()].sort((a, b) => recencyOf(b[1]) - recencyOf(a[1])).slice(0, maxEntries)
    pins.clear()
    for (const [key, pin] of ordered) pins.set(key, pin)
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty) return
    prune()
    try {
      mkdirSync(dir, { recursive: true })
      const body = JSON.stringify({ version: 1, sessions: Object.fromEntries(pins) })
      const tmp = `${file}.tmp-${String(process.pid)}`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
      // Cleared only after the bytes landed: a failed write must stay dirty so
      // the next touch retries instead of silently forgetting the change.
      dirty = false
    } catch (error) {
      dirty = true
      // A rename that failed after the write left a partial temp file behind;
      // one per failed attempt would accumulate for the life of the process.
      try {
        rmSync(`${file}.tmp-${String(process.pid)}`, { force: true })
      } catch {
        // Nothing to clean, or it cannot be cleaned: the retry still writes.
      }
      try {
        console.warn(`[memory-gate] session store write failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Diagnostics must never turn a storage problem into a call failure.
      }
    }
  }

  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessions?: unknown }
      const sessions = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
      if (sessions !== null && typeof sessions === 'object') {
        for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
          const pin = pinFromUnknown(value)
          if (pin !== undefined) pins.set(key, pin)
        }
      }
    }
  } catch (error) {
    // Never let the next flush erase a file we failed to understand: keep a
    // copy first, then start empty (the gate simply re-decides).
    try {
      copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Best effort: an unreadable *and* uncopyable file has nothing to save.
    }
    console.warn(`[memory-gate] session store unreadable, kept a copy before rewriting: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    get: (sessionId) => pins.get(sessionId),
    set: (sessionId, pin) => {
      pins.set(sessionId, pin)
      dirty = true
    },
    delete: (sessionId) => {
      if (!pins.delete(sessionId)) return
      dirty = true
    },
    size: () => pins.size,
    touch: () => {
      if (!dirty) return
      // The very first pin of a run writes immediately: a process that dies
      // before the debounce fires would otherwise forget which sessions it
      // had already registered — and re-registering a bypassed session cannot
      // undo the proxy's terminal state, only decide the wrong thing faster.
      if (!wroteOnce) {
        wroteOnce = true
        flush()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, 1_000)
      timer.unref?.()
    },
    flush,
  }
}

/**
 * Append one decision line, rotating the log when it grows past
 * {@link MAX_LOG_BYTES}.
 *
 * Appending is asynchronous (a log write must never sit in the request path)
 * but *ordering* is still guaranteed: concurrent callers chain onto one tail,
 * so lines land in call order and `flushDecisionLog()` can wait for the last
 * one. Keeping the chain per-file also means a rotation cannot overtake a
 * pending append from an earlier call.
 */
const logTails = new Map<string, Promise<void>>()

/** Resolve once every decision append issued so far has hit the disk. */
export function flushDecisionLog(dir: string): Promise<void> {
  return logTails.get(join(dir, 'decisions.jsonl')) ?? Promise.resolve()
}

export function appendDecisionLog(dir: string, line: string): void {
  const file = join(dir, 'decisions.jsonl')
  const previous = logTails.get(file) ?? Promise.resolve()
  // Create the directory synchronously, before queueing: the session store's
  // own mkdir is debounced behind a flush, so a fresh install's first decision
  // still needs one. Doing it here rather than inside the chain also keeps the
  // path valid at call time — by the time a queued append runs, teardown (or a
  // test's temp-dir cleanup) may already have removed the tree, and a late
  // `mkdir` would resurrect it or fail with ENOENT.
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn(`[memory-gate] decision log skipped: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const next = previous.then(async () => {
    try {
      let size = 0
      try {
        size = (await stat(file)).size
      } catch {
        size = 0
      }
      if (size >= MAX_LOG_BYTES) {
        try {
          await rename(file, `${file}.1`)
        } catch {
          // Append to the oversized file instead.
        }
      }
      await appendFileAsync(file, `${line}\n`, 'utf8')
    } catch (error) {
      // A vanished tree is a legitimate outcome: uninstall and temp cleanup
      // both remove the directory out from under a queued append. Dropping the
      // line is the documented behaviour — the log is diagnostics, not state —
      // and warning about it would only add noise at teardown.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      console.warn(`[memory-gate] decision log append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  logTails.set(file, next)
  // Let the map shed finished files so a long run does not retain one entry
  // per directory ever used.
  void next.finally(() => {
    if (logTails.get(file) === next) logTails.delete(file)
  })
}