/**
 * Host-half behavior over a minimal fake Cordis context: listener
 * registration, header stamping on `llm-pi-ai/request-headers`, the
 * per-session pinning, fail-open behavior, write-time config validation and the 0.1.5 legacy
 * settings namespace.
 *
 * The fake is deliberately small and explicit: the plugin only touches
 * `settings`, `on`, `effect`, `get` and `fiber`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { apply, Config as PluginConfig, inject as pluginInject, name as pluginName, type Config } from '../src/index.js'
import { MEMORY_GATE_NS, PI_AI_NS } from '../src/constants.js'
import { assertValidSection, defaultSection } from '../src/identities.js'
import { flushDecisionLog } from '../src/store.js'
import type { IdentityProfile, MemoryGateSection } from '../src/identities.js'

const CHAIN = 'http://127.0.0.1:8096/dsh/default'
const DIRECT = 'https://api.stepfun.com/v1'

/** The fiber marker `apply()` compares against. */
const FIBER = { marker: 'own-fiber' }

/** A waterfall listener as the fake records it. */
type Listener = (...args: never[]) => unknown

/** One fake-host harness created by a test. */
interface Harness {
  /** Every listener registered by name, in registration order. */
  listeners: Map<string, Listener[]>
  /** The only listener of a name (fails loudly when the plugin registered none). */
  listenerOf(name: string): Listener
  /** Call every listener of a waterfall event and return the last result. */
  emit(name: string, ...args: unknown[]): unknown
  /** The current pi-ai user layer served to the plugin. */
  setPiOverride(value: Record<string, unknown> | undefined): void
  /** Per-invocation state of the fake `settings` service. */
  settings: Record<string, unknown>
  /** Run every disposer the plugin registered through `effect()`. */
  dispose(): void
}

/** Identity literal. */
function identity(overrides: Partial<IdentityProfile> = {}): IdentityProfile {
  return { id: 'main', team: 'team-a', agent: 'agent-a', task: 'task-a', headers: [], ...overrides }
}

/** Base config literal. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return { identities: [identity()], defaultIdentity: 'main', ...overrides }
}

/** A pi-ai settings document with one route. */
function piDocument(models: Array<Record<string, unknown>>, baseURL = CHAIN): Record<string, unknown> {
  return { providers: { magpie: { baseURL, models } } }
}

/**
 * Build the fake context, apply the plugin against `config`, and hand back the
 * captured seams.
 */
function makeHarness(options: {
  config?: Config
  settings?: Record<string, unknown>
  services?: Record<string, unknown>
} = {}): Harness {
  const listeners = new Map<string, Listener[]>()
  const disposes: Array<() => void> = []
  let piOverride: Record<string, unknown> | undefined
  const settings: Record<string, unknown> = options.settings ?? {}
  const services: Record<string, unknown> = options.services ?? {}
  const ctx = {
    settings,
    fiber: FIBER,
    on(name: string, listener: Listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn: () => unknown) {
      const dispose = fn()
      if (typeof dispose === 'function') disposes.push(dispose as () => void)
      return dispose
    },
    get(name: string) {
      return services[name]
    },
  }
  // The config editor seam: the plugin asks for the raw user layer of its own
  // entry and of llm-pi-ai on every decision.
  if (services['configEditor'] === undefined) {
    services['configEditor'] = {
      configuration: () => piOverride === undefined
        ? []
        : [{ entry: { options: { id: PI_AI_NS } }, override: piOverride }],
    }
  }
  apply(ctx as never, options.config ?? {})
  const harness: Harness = {
    listeners,
    settings,
    listenerOf(name) {
      const list = listeners.get(name)
      if (list === undefined || list.length === 0) throw new Error(`no listener registered for ${name}`)
      return list[0] as Listener
    },
    emit(name, ...args) {
      let result: unknown
      for (const listener of listeners.get(name) ?? []) result = listener(...(args as never[]))
      return result
    },
    setPiOverride(value) {
      piOverride = value
    },
    dispose() {
      for (const dispose of disposes.splice(0)) dispose()
    },
  }
  created.push(harness)
  return harness
}

/** Drive `llm-pi-ai/request-headers` with a fresh Headers object. */
function requestHeaders(
  harness: Harness,
  context: { provider?: string; model?: string; baseURL?: string; sessionId?: string; purpose?: string },
  headers = new Headers({ 'x-existing': 'kept' }),
): { headers: Headers; next: Mock; result: unknown } {
  const next = vi.fn(() => headers)
  const result = harness.emit('llm-pi-ai/request-headers', context, headers, next)
  return { headers, next, result }
}

/** Harnesses created during one test, disposed in afterEach. */
const created: Harness[] = []
let home: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env['DSH_HOME']
  home = mkdtempSync(join(tmpdir(), 'memory-gate-host-'))
  process.env['DSH_HOME'] = home
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const harness of created.splice(0)) harness.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('plugin registration', () => {
  it('declares the settings dependency and the stable package name', () => {
    expect(pluginName).toBe('dsh-memory-gate')
    expect(pluginInject).toEqual(['settings'])
    expect(PluginConfig).toBeDefined()
  })

  it('registers the header and config hooks but no llm/stream hook', () => {
    const harness = makeHarness({ config: baseConfig() })
    expect([...harness.listeners.keys()].sort()).toEqual(['internal/config', 'llm-pi-ai/request-headers'])
    expect(harness.listeners.has('llm/stream')).toBe(false)
    for (const name of ['llm-pi-ai/request-headers', 'internal/config']) {
      expect(harness.listeners.get(name)).toHaveLength(1)
    }
    const { headers, next } = requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' })
    expect(Object.fromEntries(headers)).toEqual({
      'x-existing': 'kept',
      'x-team-id': 'team-a',
      'x-agent-id': 'agent-a',
      'x-task-id': 'task-a',
      'x-deepseek-harness-session-id': 'session-1',
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('asks the 0.1.7 settings service to keep the browser-supplied card (auto: false)', () => {
    const configured: Array<{ auto?: boolean }> = []
    const harness = makeHarness({
      settings: {
        configure(presentation: { auto?: boolean }) {
          configured.push(presentation)
          return () => {}
        },
        describe: () => [],
      },
    })
    expect(configured).toEqual([{ auto: false }])
    // The configure disposer is registered through effect() and runs on dispose.
    expect(() => { harness.dispose() }).not.toThrow()
  })
})

describe('llm-pi-ai/request-headers', () => {
  it('stamps the identity triple and the harness session header on a memory-chain request', () => {
    const harness = makeHarness({ config: baseConfig() })
    const { headers, next, result } = requestHeaders(harness, {
      provider: 'magpie',
      model: 'm1',
      baseURL: CHAIN,
      sessionId: 'session-1',
    })
    expect(result).toBe(headers)
    expect(headers.get('x-team-id')).toBe('team-a')
    expect(headers.get('x-agent-id')).toBe('agent-a')
    expect(headers.get('x-task-id')).toBe('task-a')
    expect(headers.get('x-deepseek-harness-session-id')).toBe('session-1')
    expect(headers.get('x-existing')).toBe('kept')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each(['off', 'pinned null'])('removes preexisting core headers on %s but retains arbitrary extras', (mode) => {
    const names = { team: 'x-custom-team', agent: 'x-custom-agent', task: 'x-custom-task' }
    const harness = makeHarness({
      config: baseConfig({ headerNames: names, sessionHeader: false,
        identities: [identity({ headers: [{ name: 'x-extra', value: 'configured' }] })] }),
    })
    harness.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'off' }]))
    if (mode === 'pinned null') {
      requestHeaders(harness, { provider: 'magpie', model: 'm1', sessionId: 'detached' })
      harness.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'default' }]))
    }
    const initial = new Headers({
      'x-custom-team': 'stale-team', 'x-custom-agent': 'stale-agent', 'x-custom-task': 'stale-task',
      'x-deepseek-harness-session-id': 'stale-session', 'x-extra': 'original', 'x-existing': 'kept',
    })
    const { headers, next } = requestHeaders(harness,
      { provider: 'magpie', model: 'm1', sessionId: 'detached' }, initial)
    expect(Object.fromEntries(headers)).toEqual({ 'x-existing': 'kept', 'x-extra': 'original' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('keeps cleaning the header names a detached session pinned before a rename', () => {
    // Pin a detach under one set of names, rename the configuration, then make
    // a request: the stale names must still be deleted, not just the new ones.
    const oldNames = { team: 'x-old-team', agent: 'x-old-agent', task: 'x-old-task' }
    const before = makeHarness({ config: baseConfig({ headerNames: oldNames, sessionHeader: false }) })
    before.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'off' }]))
    requestHeaders(before, { provider: 'magpie', model: 'm1', sessionId: 'renamed' })
    before.dispose()

    const after = makeHarness({ config: baseConfig({ headerNames: { team: 'x-new-team', agent: 'x-new-agent', task: 'x-new-task' }, sessionHeader: false }) })
    // The route must still resolve to the trusted chain, or the request is skipped.
    after.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'default' }]))
    const initial = new Headers({
      'x-old-team': 'stale-team', 'x-old-agent': 'stale-agent', 'x-old-task': 'stale-task',
      'x-new-team': 'never-set', 'x-existing': 'kept',
    })
    const { headers } = requestHeaders(after, { provider: 'magpie', model: 'm1', sessionId: 'renamed' }, initial)
    expect(Object.fromEntries(headers)).toEqual({ 'x-existing': 'kept' })
  })

  it('leaves all preexisting memory headers unchanged on an untrusted chain-shaped route', () => {
    const harness = makeHarness({ config: baseConfig() })
    harness.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'off' }], 'https://untrusted.example/dsh/default'))
    const initial = new Headers({
      'x-team-id': 'original-team', 'x-agent-id': 'original-agent', 'x-task-id': 'original-task',
      'x-deepseek-harness-session-id': 'original-session', 'x-extra': 'original-extra',
    })
    const before = Object.fromEntries(initial)
    const { headers, next } = requestHeaders(harness,
      { provider: 'magpie', model: 'm1', sessionId: 's' }, initial)
    expect(Object.fromEntries(headers)).toEqual(before)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('attaches on a trusted custom origin read from a live configuration cell', () => {
    const harness = makeHarness({ config: baseConfig({
      trustedOrigins: { get: () => ['https://memory.example:8443'] },
    }) })
    const { headers } = requestHeaders(harness, {
      provider: 'magpie', model: 'm1', baseURL: 'https://memory.example:8443/dsh/custom', sessionId: 'custom',
    })
    expect(headers.get('x-team-id')).toBe('team-a')
    expect(headers.get('x-deepseek-harness-session-id')).toBe('custom')
  })

  it('honours the sessionHeader switch', () => {
    const harness = makeHarness({ config: baseConfig({ sessionHeader: false }) })
    const { headers } = requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' })
    expect(headers.get('x-team-id')).toBe('team-a')
    expect(headers.get('x-deepseek-harness-session-id')).toBeNull()
  })

  it('leaves a direct (non-memory-chain) route untouched', () => {
    const harness = makeHarness({ config: baseConfig({ sessionHeader: false }) })
    const { headers, next, result } = requestHeaders(harness, { provider: 'stepfun', model: 'm1', baseURL: DIRECT, sessionId: 's' })
    expect(result).toBe(headers)
    expect([...headers.entries()]).toEqual([['x-existing', 'kept']])
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('leaves the headers alone when the request names no provider or model', () => {
    const harness = makeHarness({ config: baseConfig() })
    const { headers, next } = requestHeaders(harness, { baseURL: CHAIN, sessionId: 's' })
    expect([...headers.entries()]).toEqual([['x-existing', 'kept']])
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('reads the route base URL and the model pick from the llm-pi-ai user layer', () => {
    const harness = makeHarness({ config: baseConfig() })
    harness.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'off' }]))
    const { headers } = requestHeaders(harness, { provider: 'magpie', model: 'm1', sessionId: 'session-1' })
    // The provider profile supplies the memory-chain base URL; the model row
    // says "off", so nothing is stamped even though the session is new.
    expect(headers.get('x-team-id')).toBeNull()
  })

  it('pins the first decision per session: a later model "off" cannot retire it', () => {
    const harness = makeHarness({ config: baseConfig() })
    const first = requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-attached' })
    expect(first.headers.get('x-team-id')).toBe('team-a')

    // The user flips the model to 摘链 after the session already carried
    // identity headers; the proxy's bypass is terminal, so the pin wins.
    harness.setPiOverride(piDocument([{ id: 'm1', memoryGate: 'off' }]))
    const again = requestHeaders(harness, { provider: 'magpie', model: 'm1', sessionId: 'session-attached' })
    expect(again.headers.get('x-team-id')).toBe('team-a')
    expect(again.headers.get('x-deepseek-harness-session-id')).toBe('session-attached')

    // A brand-new session takes the new decision and stays detached.
    const fresh = requestHeaders(harness, { provider: 'magpie', model: 'm1', sessionId: 'session-detached' })
    expect(fresh.headers.get('x-team-id')).toBeNull()
    expect(fresh.headers.get('x-deepseek-harness-session-id')).toBeNull()
  })

  it('drops only the malformed header row and keeps the identity triple', () => {
    // A composition-base section can reach the gate without passing the
    // write-time validator (apply() reads the cordis row directly). An
    // unrepresentable extra row is dropped alone: the identity triple and the
    // session header still reach the wire, and the model call goes ahead.
    const harness = makeHarness({
      config: baseConfig({ identities: [identity({ headers: [{ name: 'bad name', value: 'v' }] })] }),
    })
    const { headers, next, result } = requestHeaders(harness, {
      provider: 'magpie',
      model: 'm1',
      baseURL: CHAIN,
      sessionId: 's',
    })
    expect(result).toBe(headers)
    expect(next).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(headers)).toEqual({
      'x-existing': 'kept',
      'x-team-id': 'team-a',
      'x-agent-id': 'agent-a',
      'x-task-id': 'task-a',
      'x-deepseek-harness-session-id': 's',
    })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unstampable header row: bad name'))
  })

  it('drops a single unstampable override of the triple without losing the memory identity', () => {
    // `headerNames.team` can also arrive from the composition base unchecked.
    // The team row is dropped; agent, task and the session header still land,
    // so the proxy still identifies the request.
    const harness = makeHarness({
      config: baseConfig({ headerNames: { team: 'bad name', agent: 'x-agent-id', task: 'x-task-id' } }),
    })
    const { headers, next } = requestHeaders(harness, {
      provider: 'magpie',
      model: 'm1',
      baseURL: CHAIN,
      sessionId: 's',
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(headers)).toEqual({
      'x-existing': 'kept',
      'x-agent-id': 'agent-a',
      'x-task-id': 'task-a',
      'x-deepseek-harness-session-id': 's',
    })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unstampable header row: bad name'))
  })

  it('keeps serving the composition base when the settings service throws', () => {
    const harness = makeHarness({
      config: baseConfig(),
      settings: {
        describe() {
          throw new Error('settings exploded')
        },
      },
    })
    const { headers, next, result } = requestHeaders(harness, {
      provider: 'magpie',
      model: 'm1',
      baseURL: CHAIN,
      sessionId: 's',
    })
    // No user layer and no provider document, but the row's own config still
    // names an identity and the routing metadata carries the chain base URL.
    expect(result).toBe(headers)
    expect(next).toHaveBeenCalledTimes(1)
    expect(headers.get('x-team-id')).toBe('team-a')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('writes one decision log line per memory-chain request and announces each session once', async () => {
    const dir = join(home, 'storage', 'memory-gate')
    const harness = makeHarness({ config: baseConfig() })
    // A direct route is skipped and leaves no trace in the log.
    requestHeaders(harness, { provider: 'stepfun', model: 'm1', baseURL: DIRECT, sessionId: 'session-direct' })
    requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' })
    requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' })

    // Ordering is part of the contract: the appended lines land in call order,
    // so the first line must describe the *first* decision (a fresh attach),
    // not the pin that supersedes it.
    await flushDecisionLog(dir)
    expect(existsSync(join(dir, 'decisions.jsonl'))).toBe(true)
    const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ kind: 'attach', session: 'session-1' })
    }
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(line).toMatchObject({
      kind: 'attach',
      reason: 'attached',
      provider: 'magpie',
      model: 'm1',
      session: 'session-1',
      identity: 'main',
      chain: CHAIN,
    })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ kind: 'attach', reason: 'pinned' })
    expect(typeof line['ts']).toBe('string')

    // The console announcement is per session, not per request.
    expect(console.info).toHaveBeenCalledTimes(1)
    expect((console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])
      .toMatch(/attach identity="main" magpie\/m1 session=session-1/)
  })

  it('still calls next() when the diagnostics themselves throw', () => {
    // The gate promises "a broken gate means no identity headers, never a
    // broken model call". A bare console.warn in the catch block breaks that:
    // with the host's stdio gone (EPIPE on a closed pipe) the write throws, the
    // exception escapes the listener and `return next()` never runs.
    const harness = makeHarness({ config: baseConfig() })
    // A value Fetch refuses makes the stamping path warn; the throw then lands
    // where a real EPIPE would.
    const broken = identity({ headers: [{ name: 'x-bad', value: 'v\u0100' }] })
    const harness2 = makeHarness({ config: { identities: [broken], defaultIdentity: 'main' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EPIPE: broken pipe, write')
    })
    try {
      for (const h of [harness, harness2]) {
        const next = vi.fn(() => new Headers())
        expect(() => h.emit('llm-pi-ai/request-headers',
          { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' },
          new Headers(), next)).not.toThrow()
        expect(next).toHaveBeenCalledTimes(1)
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('persists the pin to sessions.json when the plugin disposes', () => {
    const harness = makeHarness({ config: baseConfig() })
    requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1' })
    harness.dispose()

    const file = join(home, 'storage', 'memory-gate', 'sessions.json')
    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version: number; sessions: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(parsed.sessions['session-1']).toMatchObject({
      identity: 'main',
      reason: 'attached',
      provider: 'magpie',
      model: 'm1',
      // The persisted decision carries its own attachment values.
      snapshot: {
        identity: { id: 'main', team: 'team-a' },
        headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
        sessionHeader: true,
      },
    })
  })

  it('keeps a live session on its pinned values after the identity is edited', () => {
    // End-to-end through real Headers + the on-disk store: the pin survives a
    // host restart and still reproduces the values it was created with.
    const first = makeHarness({ config: baseConfig() })
    const headers = requestHeaders(first, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-live' })
    expect(headers.headers.get('x-team-id')).toBe('team-a')
    first.dispose()

    const edited = makeHarness({ config: baseConfig({ identities: [identity({ team: 'team-edited' })] }) })
    const again = requestHeaders(edited, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-live' })
    expect(again.headers.get('x-team-id')).toBe('team-a')

    // A new session takes the edited value.
    const fresh = requestHeaders(edited, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-new' })
    expect(fresh.headers.get('x-team-id')).toBe('team-edited')
  })

  it('persists a legacy pin migration and never migrates from an auxiliary call', () => {
    // Seed the on-disk legacy shape (id only), then let a main request migrate
    // it and an auxiliary call reuse it. Only the main request may write.
    const file = join(home, 'storage', 'memory-gate', 'sessions.json')
    mkdirSync(join(home, 'storage', 'memory-gate'), { recursive: true })
    const legacy = { identity: 'main', reason: 'attached', at: 5, provider: 'magpie', model: 'm1' }
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { 'session-old': legacy } }))

    const auxiliary = makeHarness({ config: baseConfig() })
    requestHeaders(auxiliary, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-old', purpose: 'title' })
    auxiliary.dispose()
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions['session-old']).toEqual(legacy)

    const main = makeHarness({ config: baseConfig() })
    const attached = requestHeaders(main, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-old' })
    expect(attached.headers.get('x-team-id')).toBe('team-a')
    main.dispose()

    const migrated = JSON.parse(readFileSync(file, 'utf8')).sessions['session-old']
    expect(migrated).toMatchObject({
      identity: 'main',
      at: 5,
      snapshot: { identity: { team: 'team-a' }, headerNames: { team: 'x-team-id' }, sessionHeader: true },
    })
    expect(typeof migrated.migratedAt).toBe('number')
  })

  it('never freezes an invalid composition-base value onto a session', () => {
    // A bad extra header must stay repairable: the request attaches, the pin
    // stays legacy, and once the config is fixed the session picks it up.
    const broken = makeHarness({ config: baseConfig({ identities: [identity({ headers: [{ name: 'bad name', value: 'v' }] })] }) })
    requestHeaders(broken, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-bad' })
    broken.dispose()
    const stored = JSON.parse(readFileSync(join(home, 'storage', 'memory-gate', 'sessions.json'), 'utf8'))
    expect(stored.sessions['session-bad'].snapshot).toBeUndefined()

    const repaired = makeHarness({ config: baseConfig({ identities: [identity({ headers: [{ name: 'X-Good', value: 'v' }] })] }) })
    const headers = requestHeaders(repaired, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-bad' })
    expect(headers.headers.get('X-Good')).toBe('v')
  })
  it('warns once at startup when the composition base is unusable, and still fails open', () => {
    // The base never passes the settings `validate` hook, so without this the
    // operator sees only the symptom (no identity headers).
    const harness = makeHarness({ config: baseConfig({ identities: [identity({ team: ' ' })] }) })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('composition base is invalid'))
    const { headers, next } = requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 's' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(headers.get('x-team-id')).toBeNull()
  })

  it('says nothing at startup when the composition base is valid', () => {
    makeHarness({ config: baseConfig() })
    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('internal/config validation', () => {
  const invalid = {
    identities: [identity(), identity({ id: 'MAIN' })],
    defaultIdentity: 'main',
  }
  const valid = { identities: [identity()], defaultIdentity: 'main' }

  it('refuses an invalid section on the owning fiber (cordis 4.0 `this` shape)', () => {
    const harness = makeHarness()
    const next = vi.fn(() => invalid)
    const listener = harness.listenerOf('internal/config') as unknown as (this: unknown, raw: unknown, next: () => unknown) => unknown
    expect(() => listener.call(FIBER, invalid, next))
      .toThrow(/duplicates the id "MAIN"/)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('refuses a section whose extra row claims the session header', () => {
    // The write path must reject it too, not just the identity validator:
    // otherwise the row would reach the pin and freeze the conversation key.
    const reserved = {
      identities: [identity({ headers: [{ name: 'x-deepseek-harness-session-id', value: 'one' }] })],
      defaultIdentity: 'main',
    }
    const harness = makeHarness()
    const next = vi.fn(() => reserved)
    const listener = harness.listenerOf('internal/config') as unknown as (this: unknown, raw: unknown, next: () => unknown) => unknown
    expect(() => listener.call(FIBER, reserved, next))
      .toThrow(/carries the session id/)
  })

  it('refuses an invalid section when cordis 4.1 passes the fiber as the first argument', () => {
    const harness = makeHarness()
    const next = vi.fn(() => invalid)
    const listener = harness.listenerOf('internal/config') as unknown as (fiber: unknown, next: () => unknown) => unknown
    expect(() => listener(FIBER, next))
      .toThrow(/duplicates the id "MAIN"/)
  })

  it('validates foreign fibers without touching their config', () => {
    const harness = makeHarness()
    const next = vi.fn(() => invalid)
    const listener = harness.listenerOf('internal/config') as unknown as (this: unknown, raw: unknown, next: () => unknown) => unknown
    expect(listener.call({}, invalid, next)).toBe(invalid)
  })

  it('passes a valid owning section through unchanged', () => {
    const harness = makeHarness()
    const next = vi.fn(() => valid)
    const listener = harness.listenerOf('internal/config') as unknown as (this: unknown, raw: unknown, next: () => unknown) => unknown
    expect(listener.call(FIBER, valid, next)).toBe(valid)
  })
})

describe('DSH 0.1.5 legacy settings namespace', () => {
  interface Hooks {
    validate(value: unknown): void
    setSource(current: () => MemoryGateSection): void
    onChange(): void
  }

  it('registers the memory-gate namespace with write-time validation and a live source', () => {
    const registrations: Array<{ owner: unknown; ns: string; hooks: Hooks }> = []
    const settings = {
      installSection(owner: unknown, ns: string, _schema: unknown, _base: unknown, hooks: Hooks) {
        registrations.push({ owner, ns, hooks })
      },
      get: () => undefined,
    }
    const harness = makeHarness({ config: baseConfig(), settings })
    expect(registrations).toHaveLength(1)
    const registered = registrations[0]
    expect(registered?.ns).toBe(MEMORY_GATE_NS)
    expect(registered?.owner).toBeDefined()
    const hooks = registered?.hooks as Hooks

    expect(() => { hooks.validate({ identities: [{ id: 'a', team: 't' }, { id: 'A', team: 't' }] }) })
      .toThrow(/duplicates the id "A"/)

    hooks.setSource(() => ({
      identities: [identity({ id: 'legacy', team: 'team-legacy', agent: 'agent-legacy', task: '' })],
      defaultIdentity: 'legacy',
      headerNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
      sessionHeader: false,
      trustedOrigins: ['http://127.0.0.1:8096'],
    }))
    hooks.onChange()

    const { headers } = requestHeaders(harness, { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 's' })
    expect(headers.get('x-team-id')).toBe('team-legacy')
    expect(headers.get('x-agent-id')).toBe('agent-legacy')
    expect(headers.get('x-task-id')).toBeNull()
  })
})
/**
 * The schema itself, not `apply()`, is what Cordis sees first: the loader
 * resolves `Config` against the row's `config:` block and only then calls
 * `apply` with the defaults-filled value. Nothing above exercises that path,
 * so a `Config` that builds but cannot resolve would ship green — exactly the
 * regression this block exists to catch.
 *
 * `Schema.resolve(data, schema, options)` takes the *value first*; calling it
 * the other way round reports `unsupported type "undefined"` for a perfectly
 * good schema, so the argument order is asserted here too.
 */
describe('Config schema under the real schemastery', () => {
  const valid = {
    identities: [identity({ id: 'w', team: 'T', agent: 'A', task: 'k', headers: [{ name: 'x-b', value: '1' }] })],
    defaultIdentity: 'w',
  }

  /**
   * Volatile fields resolve to a live cell carrying a `get()` — that is the
   * `VolatileLike<T>` shape `apply` reads. Non-volatile siblings resolve
   * plainly. This helper reads either form so the assertions stay about
   * values rather than about the cell wrapper.
   */
  const valueOf = <T>(cell: T | { get(): T }): T =>
    cell && typeof cell === 'object' && typeof (cell as { get?: unknown }).get === 'function'
      ? (cell as { get(): T }).get()
      : (cell as T)

  it('resolves the empty row config to every default', () => {
    const [resolved] = Schema.resolve({}, PluginConfig, {})
    expect(valueOf(resolved.identities as IdentityProfile[] | { get(): IdentityProfile[] })).toEqual([])
    expect(valueOf(resolved.defaultIdentity as string | { get(): string })).toBe('')
    expect(resolved.headerNames).toEqual({ team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' })
    expect(valueOf(resolved.sessionHeader as boolean | { get(): boolean })).toBe(true)
    expect(valueOf(resolved.trustedOrigins as string[] | { get(): string[] })).toEqual(['http://127.0.0.1:8096'])
  })

  it('keeps a configured identity intact', () => {
    const [resolved] = Schema.resolve(valid, PluginConfig, {})
    const ids = valueOf(resolved.identities as IdentityProfile[] | { get(): IdentityProfile[] })
    expect(ids.map((one) => one.id)).toEqual(['w'])
    expect(ids[0].headers).toEqual([{ name: 'x-b', value: '1' }])
    expect(valueOf(resolved.defaultIdentity as string | { get(): string })).toBe('w')
  })

  it('resolves a partial config without dropping sibling defaults', () => {
    const [resolved] = Schema.resolve({ sessionHeader: false }, PluginConfig, {})
    expect(valueOf(resolved.sessionHeader as boolean | { get(): boolean })).toBe(false)
    expect(resolved.headerNames.team).toBe('x-team-id')
  })

  it('agrees with the write-time validator on a bad identity', () => {
    // `apply` validates through `internal/config`; the schema must not be more
    // permissive, or a row could load with an identity the gate then drops.
    const bad = { ...defaultSection(), identities: [identity({ id: 'a', team: '' })] }
    expect(() => assertValidSection(bad)).toThrow(/team/)
  })
})
