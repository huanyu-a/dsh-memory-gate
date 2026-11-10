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
 * Loading is synchronous (a few hundred KB at most) so the first request of a
 * restarted session already sees its pin; writes are debounced off the request
 * path, because a model call must never wait on this plugin's disk.
 *
 * @module dsh-memory-gate/store
 */

import {
  appendFile,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { appendFile as appendFileAsync, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionPin } from './gate.js'

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
  /** Drop one session's pin (a new session reuses its id after a reset). */
  delete(sessionId: string): void
  /** Number of retained pins. */
  size(): number
  /** Schedule a flush of pending changes (no-op when nothing changed). */
  touch(): void
  /** Flush pending changes now (plugin teardown / tests). */
  flush(): void
}

/** Coerce a persisted record into a pin, or undefined when it cannot be trusted. */
function pinFromUnknown(value: unknown): SessionPin | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const identity = record['identity']
  if (identity !== null && typeof identity !== 'string') return undefined
  return {
    identity,
    reason: typeof record['reason'] === 'string' ? record['reason'] : 'unknown',
    at: typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : 0,
    provider: typeof record['provider'] === 'string' ? record['provider'] : '',
    model: typeof record['model'] === 'string' ? record['model'] : '',
  }
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

  const prune = (): void => {
    if (pins.size <= maxEntries) return
    const ordered = [...pins.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, maxEntries)
    pins.clear()
    for (const [key, pin] of ordered) pins.set(key, pin)
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty) return
    dirty = false
    prune()
    try {
      mkdirSync(dir, { recursive: true })
      const body = JSON.stringify({ version: 1, sessions: Object.fromEntries(pins) })
      const tmp = `${file}.tmp-${String(process.pid)}`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      console.warn(`[memory-gate] session store write failed: ${error instanceof Error ? error.message : String(error)}`)
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
  } catch {
    // A missing or unreadable file means "no pins yet": the gate decides fresh.
  }

  return {
    get: (sessionId) => pins.get(sessionId),
    set: (sessionId, pin) => {
      pins.set(sessionId, pin)
      dirty = true
    },
    delete: (sessionId) => {
      if (pins.delete(sessionId)) dirty = true
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