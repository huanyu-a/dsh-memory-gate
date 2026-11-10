/**
 * Host half of dsh-memory-gate.
 *
 * Two jobs:
 *   1. Own the `memory-gate` configuration: named memory identities (the
 *      TDAI proxy's `x-team-id` / `x-agent-id` / `x-task-id` triple plus extra
 *      headers), the default identity, the header names, the per-session
 *      budget gate and the harness-session header switch. Where the data
 *      lives depends on the host generation:
 *        - DSH 0.1.7+: the plugin entry's volatile config fields, persisted in
 *          the profile's cordis patch and edited live; and
 *        - DSH 0.1.5: the `memory-gate` settings namespace, registered with
 *          write-time validation and persisted in the user settings document.
 *   2. Decide, per request, whether it carries a memory identity. The decision
 *      runs on two harness waterfalls:
 *        - `llm/stream` observes every request (messages, provider, model,
 *          session id) and feeds the budget estimator; and
 *        - `llm-pi-ai/request-headers` is the synchronous, per-inference header
 *          seam where the decision becomes wire headers.
 *      The first decision of a session id is pinned (see gate.ts): the TDAI
 *      proxy's `bypassed` state is terminal, so a session must never flip
 *      between identified and unidentified requests.
 *
 * Nothing here sits on the critical path of a model call except a Map lookup
 * and a `Headers.set`; disk writes are debounced, and every failure degrades to
 * "send no identity headers" — the model call itself is never at stake.
 *
 * @module dsh-memory-gate
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer/llm/settings service merges into this program's Context.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: declares the `llm-pi-ai/request-headers` event this plugin listens to.
import type { PiAiRequestHeaderContext } from '@deepseek-ai/dsh-llm-pi-ai'
import Schema from '@deepseek-ai/schemastery'
import { MEMORY_GATE_NS, PI_AI_NS, PLUGIN_ID } from './constants.js'
import {
  defaultSection,
  isRecord,
  modelPickOf,
  normalizeSection,
  providerBaseURL,
  assertValidSection,
  estimateTokens,
  type BudgetConfig,
  type HeaderEntry,
  type HeaderNames,
  type IdentityProfile,
  type MemoryGateSection,
} from './identities.js'
import { decideGate, describeDecision, type GateDecision, type GateRequest } from './gate.js'
import { appendDecisionLog, createSessionStore, flushDecisionLog, storeDir } from './store.js'

/** Stable plugin id (cordis plugin name, bundle id, client module id). The cordis row id is `memory-gate`. */
export const name = PLUGIN_ID

/** Hard dependencies: the loader waits for `settings` before calling apply. */
export const inject = ['settings']

/** The branded settings namespaces this plugin owns (memory-gate) and reads (llm-pi-ai). */
const OWN_NS = MEMORY_GATE_NS
const PI_NS = PI_AI_NS

const headerEntry: Schema<HeaderEntry> = Schema.object({
  name: Schema.string().required(),
  value: Schema.string().default(''),
})

const identity: Schema<IdentityProfile> = Schema.object({
  id: Schema.string().required(),
  team: Schema.string().default(''),
  agent: Schema.string().default(''),
  task: Schema.string().default(''),
  headers: Schema.array(headerEntry).default([]),
})

const headerNames: Schema<HeaderNames> = Schema.object({
  team: Schema.string().default(defaultSection().headerNames.team),
  agent: Schema.string().default(defaultSection().headerNames.agent),
  task: Schema.string().default(defaultSection().headerNames.task),
})

const budget: Schema<BudgetConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  maxRequestTokens: Schema.number().default(defaultSection().budget.maxRequestTokens),
})

/**
 * A live configuration cell: DSH 0.1.7 wraps `.volatile()` Config fields in
 * one of these so edits apply without remounting the plugin fiber; DSH 0.1.5
 * resolves the same field to a plain value. Declared structurally so the
 * plugin typechecks against either cordis generation.
 */
export interface VolatileLike<T> {
  get(): T
}

/** Plugin configuration, supplied through the profile's cordis layer (the row's `config:` block). */
export interface Config {
  /** Composition-base identities (default none). */
  identities?: IdentityProfile[] | VolatileLike<IdentityProfile[]>
  /** Composition-base default identity id (default empty = memory detached until configured). */
  defaultIdentity?: string | VolatileLike<string>
  /** Composition-base header names (default the proxy's own names). */
  headerNames?: HeaderNames | VolatileLike<HeaderNames>
  /** Composition-base budget gate (default disabled). */
  budget?: BudgetConfig | VolatileLike<BudgetConfig>
  /** Whether to send the harness session header (default true). */
  sessionHeader?: boolean | VolatileLike<boolean>
}

/**
 * Probe the schemastery capability that 0.1.7+ ships: `.volatile()` does not
 * exist before 3.18.2 (DSH 0.1.5), so the same schema must build on both
 * generations. Plain on 0.1.5, live-editable on 0.1.7+.
 *
 * `volatile()` marks the schema it is called on and returns that same marked
 * schema, so calling it on an already-built field is correct — the probe below
 * verifies the *result* resolves, which is the property the loader relies on.
 * (`Schema.resolve` takes the value first: `resolve(data, schema, options)`.)
 */
const supportsVolatile: boolean = (() => {
  try {
    const field = Schema.string().default('x') as unknown as { volatile?: unknown }
    if (typeof field.volatile !== 'function') return false
    const marked = (field as unknown as { volatile(): unknown }).volatile()
    Schema.resolve('x', marked as never, {})
    return true
  } catch {
    return false
  }
})()

/** Mark a field live-editable where the loader supports it; otherwise leave it plain. */
function live<T>(field: Schema<T>): Schema<T> {
  if (!supportsVolatile) return field
  return (field as unknown as { volatile(): Schema<T> }).volatile()
}

/** Schemastery schema: Cordis validates the row config and fills defaults before apply(). */
export const Config = Schema.object({
  identities: live(Schema.array(identity).default([])),
  defaultIdentity: live(Schema.string().default('')),
  headerNames,
  budget,
  sessionHeader: live(Schema.boolean().default(true)),
})

// ---- settings structural faces (compile-time privacy only; every access
// ---- fails open so a kernel drift degrades to "no memory identity", never
// ---- to a broken dispatch). ----

/** The settings service face of DSH 0.1.5: registered namespaces. */
interface LegacySettingsFace {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    base: MemoryGateSection,
    hooks: {
      validate(value: MemoryGateSection): void
      setSource(current: () => MemoryGateSection): void
      onChange(): void
    },
  ): unknown
  get(ns: string): unknown
}

/** The settings service face of DSH 0.1.7+: schema-derived forms over profile plugin entries. */
interface SettingsFormsFace {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  describe(): Array<{ ns: string; value: unknown }>
}

/** The profile editor's raw user layers (retains plugin-owned fields). */
interface ConfigEditorFace {
  configuration(): Array<{
    entry: { options: { id: string } }
    override: Record<string, unknown>
  }>
}

/** The union face: each member is probed before use, never assumed. */
type SettingsFace = Partial<LegacySettingsFace & SettingsFormsFace>

/** Read a maybe-volatile configuration field. */
function volatileRead<T>(value: T | VolatileLike<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { get?: unknown }).get === 'function') {
    return (value as VolatileLike<T>).get()
  }
  return value as T | undefined
}

/** The `llm/stream` request shape this plugin observes. */
interface StreamOptionsLike {
  provider?: unknown
  model?: unknown
  sessionId?: unknown
  messages?: unknown
}

/** Coarse token estimate per session id, refreshed by every observed request. */
interface TokenStat {
  tokens: number
  at: number
}

/** How many sessions keep a live token estimate. */
const MAX_TOKEN_SESSIONS = 512

/**
 * Apply the plugin.
 * @param ctx - host context.
 * @param config - the cordis row's config block (composition base).
 */
export function apply(ctx: Context, config: Config = {}): void {
  /** The default section from the composition base (no editor layer). */
  const baseSection = (): MemoryGateSection => normalizeSection({
    identities: volatileRead(config.identities) ?? [],
    defaultIdentity: volatileRead(config.defaultIdentity) ?? '',
    headerNames: volatileRead(config.headerNames),
    budget: volatileRead(config.budget),
    sessionHeader: volatileRead(config.sessionHeader),
  })

  const settings = ctx.settings as unknown as SettingsFace | undefined
  const runtimeContext = ctx as unknown as { get?(name: string): unknown }
  const editor = typeof runtimeContext.get === 'function'
    ? runtimeContext.get('configEditor') as ConfigEditorFace | undefined
    : undefined

  /** The raw user layer of one plugin entry, when the editor service is present. */
  const editorOverride = (id: string): Record<string, unknown> | undefined => {
    try {
      return editor?.configuration().find(row => row.entry.options.id === id)?.override
    } catch {
      return undefined
    }
  }

  if (typeof settings?.configure === 'function') {
    const forms = settings as SettingsFormsFace
    const fiber = (ctx as { fiber?: unknown }).fiber
    if (fiber !== undefined) {
      // The browser half ships the configuration card; no schema-derived page.
      ctx.effect(() => forms.configure({ auto: false }, fiber), 'memory-gate: settings page policy')
    }
  }

  // Write-time validation: the loader's internal/config waterfall runs on every
  // entry recompose, and a throw refuses the change (the settings write
  // surfaces it verbatim). Cordis 4.0 binds the owning fiber to `this` and
  // passes the raw config first; Cordis 4.1 passes that fiber as the first
  // argument. Reading both shapes keeps one artifact compatible.
  const fiber = (ctx as { fiber?: unknown }).fiber
  ctx.on('internal/config', function (this: unknown, fiberOrRaw: unknown, next: () => unknown) {
    const nextConfig = next()
    const own = this === fiber || fiberOrRaw === fiber
    if (!own) return nextConfig
    assertValidSection(normalizeSection(nextConfig))
    return nextConfig
  })

  let legacySection: () => MemoryGateSection = baseSection
  if (typeof settings?.installSection === 'function' && typeof settings.configure !== 'function') {
    // DSH 0.1.5: register the owned namespace with write-time validation.
    const legacy = settings as LegacySettingsFace
    let source: () => MemoryGateSection = baseSection
    let current = baseSection()
    legacy.installSection(ctx, OWN_NS, Config, current, {
      validate: (value) => {
        assertValidSection(normalizeSection(value))
      },
      setSource: (next) => {
        source = next
      },
      onChange: () => {
        current = normalizeSection(source())
      },
    })
    legacySection = () => current
  }

  /** The settings service's projected value of one namespace, when it serves one. */
  const describedValue = (ns: string): unknown => {
    try {
      if (typeof settings?.describe !== 'function') return undefined
      return settings.describe().find(entry => entry.ns === ns)?.value
    } catch {
      return undefined
    }
  }

  /** The resolved section of this request: composition base overlaid by the user layer. */
  const readSection = (): MemoryGateSection => {
    const override = editorOverride(OWN_NS)
    const described = describedValue(OWN_NS)
    if (override === undefined && described === undefined) return legacySection()
    const userLayer = { ...(isRecord(described) ? described : {}), ...(override ?? {}) }
    return normalizeSection({ ...baseSection(), ...userLayer })
  }

  /** The resolved pi-ai providers dict (the route profiles the models page edits). */
  const readProviders = (): unknown => {
    const override = editorOverride(PI_NS)
    if (override !== undefined) return override['providers']
    const described = describedValue(PI_NS)
    return isRecord(described) ? described['providers'] : undefined
  }

  const dir = storeDir()
  const store = createSessionStore(dir)
  ctx.effect(() => () => store.flush(), 'memory-gate: flush session pins')
  // Decision lines are appended off the request path. Cordis ignores a promise
  // returned from a disposer, so the tail is drained here best-effort: the
  // fs operations are already queued in order and settle before the process
  // can exit on a normal teardown.
  ctx.effect(() => () => {
    void flushDecisionLog(dir)
  }, 'memory-gate: flush decision log')

  /** Tel estimate per session, fed by `llm/stream`. */
  const tokenStats = new Map<string, TokenStat>()
  const rememberTokens = (sessionId: string, tokens: number, at: number): void => {
    tokenStats.set(sessionId, { tokens, at })
    if (tokenStats.size <= MAX_TOKEN_SESSIONS) return
    const ordered = [...tokenStats.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TOKEN_SESSIONS)
    tokenStats.clear()
    for (const [key, stat] of ordered) tokenStats.set(key, stat)
  }

  /** Sessions already announced on the console (one line per session, not per request). */
  const announced = new Set<string>()

  /** Append one structured decision line for the on-disk log. */
  const logDecision = (decision: GateDecision, request: GateRequest, tokens: number | undefined): void => {
    appendDecisionLog(dir, JSON.stringify({
      ts: new Date().toISOString(),
      kind: decision.kind,
      reason: decision.reason,
      provider: request.provider,
      model: request.model,
      session: request.sessionId ?? null,
      identity: decision.identity?.id ?? null,
      tokens: tokens ?? null,
      chain: request.baseURL ?? null,
    }))
  }

  // Observe every request's size: the budget gate needs to know how large a
  // conversation already is before the proxy appends memory to it.
  ctx.on('llm/stream', function (options: StreamOptionsLike, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    try {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
      const messages = Array.isArray(options.messages) ? options.messages : undefined
      if (sessionId !== undefined && messages !== undefined) {
        rememberTokens(sessionId, estimateTokens(messages), Date.now())
      }
    } catch (error) {
      console.warn(`[memory-gate] request observation skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // The synchronous per-inference header seam: decide and stamp.
  ctx.on('llm-pi-ai/request-headers', function (
    context: PiAiRequestHeaderContext,
    headers: Headers,
    next: () => Headers,
  ): Headers {
    try {
      const provider = typeof context.provider === 'string' ? context.provider : ''
      const model = typeof context.model === 'string' ? context.model : ''
      if (provider.length === 0 || model.length === 0) return next()
      const sessionId = typeof context.sessionId === 'string' && context.sessionId.length > 0
        ? context.sessionId
        : undefined
      const providers = readProviders()
      const baseURL = (typeof context.baseURL === 'string' && context.baseURL.length > 0
        ? context.baseURL
        : undefined) ?? providerBaseURL(providers, provider)
      const request: GateRequest = {
        provider,
        model,
        baseURL,
        sessionId,
        pinnable: context.purpose === undefined,
        estimatedTokens: sessionId === undefined ? undefined : tokenStats.get(sessionId)?.tokens,
      }
      const decision = decideGate({
        request,
        section: readSection(),
        pick: modelPickOf(providers, provider, model),
        pin: sessionId === undefined ? undefined : store.get(sessionId),
        now: Date.now(),
      })
      if (decision.kind === 'skip') {
        // Not a memory-chain route: leave every header exactly as found.
        return next()
      }
      if (decision.pin !== undefined && sessionId !== undefined) {
        store.set(sessionId, decision.pin)
        store.touch()
      }
      // Stamp row by row, dropping only the rows Fetch refuses: one
      // unrepresentable extra header (a composition-base row that never met
      // the write-time validator) must not cost the request its identity
      // triple and session header.
      const dropped: string[] = []
      for (const [name, value] of Object.entries(decision.headers)) {
        try {
          headers.set(name, value)
        } catch {
          dropped.push(name)
        }
      }
      if (dropped.length > 0) {
        console.warn(`[memory-gate] gate skipped ${String(dropped.length)} unstampable header row: ${dropped.join(', ')}`)
      }
      logDecision(decision, request, request.estimatedTokens)
      if (!announced.has(sessionId ?? `${provider}/${model}`)) {
        announced.add(sessionId ?? `${provider}/${model}`)
        console.info(`[memory-gate] ${describeDecision(decision, request)}`)
      }
    } catch (error) {
      // Fail open: a broken gate means "no identity headers", never a broken call.
      console.warn(`[memory-gate] gate skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })
}

export { MEMORY_GATE_NS, PI_AI_NS, PLUGIN_ID } from './constants.js'
export {
  assertValidSection,
  defaultSection,
  estimateTokens,
  findIdentity,
  identityFromUnknown,
  isMemoryChain,
  modelPickOf,
  normalizeSection,
  parsePick,
  providerBaseURL,
  validateIdentities,
} from './identities.js'
export type {
  BudgetConfig,
  HeaderEntry,
  HeaderNames,
  IdentityIssue,
  IdentityProfile,
  MemoryGateSection,
  ModelPick,
} from './identities.js'
export { decideGate, describeDecision } from './gate.js'
export type { GateDecision, GateRequest, SessionPin } from './gate.js'