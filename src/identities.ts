/**
 * Pure memory-gate logic shared by the host and browser halves: the identity
 * section shape, its validation (case-insensitive id uniqueness, Fetch-valid
 * header names), the per-model pick, call-time header assembly, memory-chain
 * recognition and the request-size estimator the budget gate uses.
 *
 * No Cordis, no DOM, no Node APIs — every function here is unit-testable in
 * isolation and safe to import from the browser half.
 *
 * @module dsh-memory-gate/identities
 */

import {
  DEFAULT_AGENT_HEADER,
  DEFAULT_TASK_HEADER,
  DEFAULT_TEAM_HEADER,
  MEMORY_CHAIN_URL_PATTERNS,
} from './constants.js'

/** One extra header row of an identity, exactly as the editor stages it. */
export interface HeaderEntry {
  /** HTTP field name; validated against Fetch (`Headers#set`) before a save lands. */
  name: string
  /** Field value; the empty string is a legal value. */
  value: string
}

/**
 * One named memory identity: the triple the TDAI proxy reads from request
 * headers (`x-team-id` / `x-agent-id` / `x-task-id`) plus optional extra
 * headers (tenant tags, tracing ids, …).
 *
 * An empty `team` means "no team header": the proxy then treats the request
 * as unidentified and falls back to its interactive form (which a non-UI
 * client cannot fill), so a usable identity always names a team.
 */
export interface IdentityProfile {
  /**
   * User-chosen identity id. Unique across identities case-insensitively —
   * "Worker" and "worker" name the same identity.
   */
  id: string
  /** `x-team-id` value. */
  team: string
  /** `x-agent-id` value. */
  agent: string
  /** `x-task-id` value; empty means the header is not sent. */
  task: string
  /** Extra headers appended after the identity triple. */
  headers: HeaderEntry[]
}

/** Identity header-name overrides (deployments may rename the three headers). */
export interface HeaderNames {
  team: string
  agent: string
  task: string
}

/** The per-session budget gate: detach memory once a conversation is large. */
export interface BudgetConfig {
  /** Whether the gate runs at all. Off by default: it changes memory behaviour. */
  enabled: boolean
  /**
   * Detach memory once the first observed request of a session is estimated
   * above this many tokens. The estimate is deliberately coarse (see
   * {@link estimateTokens}) — it is a guard rail, not a tokenizer.
   */
  maxRequestTokens: number
}

/** The `memory-gate` settings section this plugin owns. */
export interface MemoryGateSection {
  identities: IdentityProfile[]
  /** Identity id every model inherits unless it names another one; empty = no default. */
  defaultIdentity: string
  headerNames: HeaderNames
  budget: BudgetConfig
  /**
   * Whether to send {@link DSH_SESSION_HEADER}. The TDAI proxy keys a
   * conversation by it, so sending it turns DSH's session into the proxy's
   * session — the difference between one registered memory session and a new
   * one every turn.
   */
  sessionHeader: boolean
}

/** The section defaults a minimal composition (and a fresh card) starts from. */
export function defaultSection(): MemoryGateSection {
  return {
    identities: [],
    defaultIdentity: '',
    headerNames: { team: DEFAULT_TEAM_HEADER, agent: DEFAULT_AGENT_HEADER, task: DEFAULT_TASK_HEADER },
    budget: { enabled: false, maxRequestTokens: 120_000 },
    sessionHeader: true,
  }
}

/** A validation finding, addressed by identity index and (for rows) row index. */
export interface IdentityIssue {
  /** Index of the offending identity in the section. */
  identity: number
  /** Index of the offending header row; absent for identity-level findings. */
  row?: number
  code: 'id-empty' | 'id-duplicate' | 'team-empty' | 'name-empty' | 'name-invalid' | 'value-invalid'
  /** Offending value, echoed for diagnostics; for `value-invalid` the header NAME (the raw value may be unprintable). */
  value: string
}

/** Whether a header NAME is representable as a Fetch header (value-independent). */
function fetchAcceptsName(name: string): boolean {
  try {
    new Headers().set(name, '')
    return true
  } catch {
    return false
  }
}

/** Whether a header VALUE is representable as a Fetch header (probed under a valid name). */
function fetchAcceptsValue(value: string): boolean {
  try {
    new Headers().set('x-mg-probe', value)
    return true
  } catch {
    return false
  }
}

/** Coerce one unknown record into an identity, dropping unrepresentable fields. */
export function identityFromUnknown(value: unknown): IdentityProfile {
  const record = isRecord(value) ? value : {}
  const headers = Array.isArray(record['headers'])
    ? record['headers'].filter(isRecord).map(row => ({
      name: typeof row['name'] === 'string' ? row['name'] : '',
      value: typeof row['value'] === 'string' ? row['value'] : '',
    }))
    : []
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    team: typeof record['team'] === 'string' ? record['team'] : '',
    agent: typeof record['agent'] === 'string' ? record['agent'] : '',
    task: typeof record['task'] === 'string' ? record['task'] : '',
    headers,
  }
}

/** Normalize one staged section; malformed values degrade to the defaults, never throw. */
export function normalizeSection(value: unknown): MemoryGateSection {
  const base = defaultSection()
  if (!isRecord(value)) return base
  const identities = Array.isArray(value['identities'])
    ? value['identities'].map(identityFromUnknown)
    : []
  const names = isRecord(value['headerNames']) ? value['headerNames'] : {}
  const budget = isRecord(value['budget']) ? value['budget'] : {}
  const maxRequestTokens = budget['maxRequestTokens']
  return {
    identities,
    defaultIdentity: typeof value['defaultIdentity'] === 'string' ? value['defaultIdentity'] : '',
    headerNames: {
      team: nonEmptyString(names['team']) ?? base.headerNames.team,
      agent: nonEmptyString(names['agent']) ?? base.headerNames.agent,
      task: nonEmptyString(names['task']) ?? base.headerNames.task,
    },
    budget: {
      enabled: budget['enabled'] === true,
      maxRequestTokens: typeof maxRequestTokens === 'number' && Number.isFinite(maxRequestTokens) && maxRequestTokens > 0
        ? Math.floor(maxRequestTokens)
        : base.budget.maxRequestTokens,
    },
    sessionHeader: value['sessionHeader'] === false ? false : base.sessionHeader,
  }
}

/** Validate one identity list, returning every finding (empty when valid). */
export function validateIdentities(section: MemoryGateSection): IdentityIssue[] {
  const issues: IdentityIssue[] = []
  const seen = new Map<string, number>()
  section.identities.forEach((identity, at) => {
    const id = identity.id.trim()
    if (id.length === 0) {
      issues.push({ identity: at, code: 'id-empty', value: identity.id })
    } else {
      const key = id.toLowerCase()
      if (seen.has(key)) issues.push({ identity: at, code: 'id-duplicate', value: id })
      else seen.set(key, at)
    }
    if (identity.team.trim().length === 0) issues.push({ identity: at, code: 'team-empty', value: id })
    identity.headers.forEach((entry, row) => {
      const name = entry.name.trim()
      if (name.length === 0) {
        // A fully blank row is an editing artifact the editor strips before
        // saving; a value without a name is a real mistake and must surface.
        if (entry.value.length > 0) issues.push({ identity: at, row, code: 'name-empty', value: entry.value })
        return
      }
      if (!fetchAcceptsName(name)) {
        issues.push({ identity: at, row, code: 'name-invalid', value: name })
      } else if (!fetchAcceptsValue(entry.value)) {
        issues.push({ identity: at, row, code: 'value-invalid', value: name })
      }
    })
  })
  return issues
}

/**
 * Throwing form of {@link validateIdentities} for the host's settings
 * `validate` hook: the write that produced an invalid section is refused
 * with a message naming the identity and row.
 * @param section - the resolved section.
 */
export function assertValidSection(section: MemoryGateSection): void {
  const issue = validateIdentities(section)[0]
  if (issue === undefined) return
  const where = issue.row === undefined
    ? `identity #${String(issue.identity + 1)}`
    : `identity #${String(issue.identity + 1)} header row #${String(issue.row + 1)}`
  const reason = {
    'id-empty': 'needs an id',
    'id-duplicate': `duplicates the id "${issue.value}" (ids are case-insensitive)`,
    'team-empty': 'needs a team id: the proxy treats a teamless request as unidentified and can never inject memory for it',
    'name-empty': 'has a value but no header name',
    'name-invalid': `uses "${issue.value}", which is not a representable HTTP header name`,
    'value-invalid': `has a value that cannot be sent as an HTTP header ("${issue.value}")`,
  }[issue.code]
  throw new Error(`memory-gate: ${where} ${reason}`)
}

/** The identity named by `id` (case-insensitive), or undefined. */
export function findIdentity(section: MemoryGateSection, id: string | undefined): IdentityProfile | undefined {
  if (id === undefined) return undefined
  const wanted = id.trim().toLowerCase()
  if (wanted.length === 0) return undefined
  return section.identities.find(identity => identity.id.trim().toLowerCase() === wanted)
}

/** What one model's row asks for: detach, inherit the default, or a named identity. */
export type ModelPick = 'off' | 'default' | { identity: string }

/** Parse a model row's {@link MEMORY_GATE_FIELD} value. Non-strings read as "default". */
export function parsePick(raw: unknown): ModelPick {
  if (typeof raw !== 'string') return 'default'
  const text = raw.trim()
  if (text.length === 0) return 'default'
  if (text.toLowerCase() === 'off') return 'off'
  if (text.toLowerCase() === 'default') return 'default'
  return { identity: text }
}

/** The model rows of one route in a providers dict (records only). */
export function modelsOf(providers: unknown, route: string): Record<string, unknown>[] {
  if (!isRecord(providers)) return []
  const profile = providers[route]
  if (!isRecord(profile)) return []
  const models = profile['models']
  if (!Array.isArray(models)) return []
  return models.filter(isRecord)
}

/** The pick of one model in a route's models; a stale or hostile document reads as "default". */
export function modelPickOf(providers: unknown, route: string, modelId: string): ModelPick {
  const entry = modelsOf(providers, route).find(model => model['id'] === modelId)
  return parsePick(entry?.['memoryGate'])
}

/** The base URL of one route's profile, when the document names a string one. */
export function providerBaseURL(providers: unknown, route: string): string | undefined {
  if (!isRecord(providers)) return undefined
  const profile = providers[route]
  if (!isRecord(profile)) return undefined
  const baseURL = profile['baseURL']
  return typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL.trim() : undefined
}

/**
 * Whether a provider base URL sits behind the TDAI memory proxy. Only that
 * route reads identity headers; a direct public route ignores them, so the
 * gate adds nothing there.
 * @param baseURL - the provider profile's base URL, if any.
 */
export function isMemoryChain(baseURL: string | undefined): boolean {
  if (baseURL === undefined || baseURL.length === 0) return false
  return MEMORY_CHAIN_URL_PATTERNS.some(pattern => pattern.test(baseURL))
}

/**
 * The headers one identity contributes: the configured triple (skipping empty
 * values) followed by extra rows (later rows win on a name clash).
 * Header names are sent verbatim; values are validated at save time.
 * @param identity - the selected identity.
 * @param names - the configured header names.
 */
export function identityHeaders(identity: IdentityProfile, names: HeaderNames): Record<string, string> {
  const headers: Record<string, string> = {}
  const team = identity.team.trim()
  const agent = identity.agent.trim()
  const task = identity.task.trim()
  if (team.length > 0) headers[names.team] = team
  if (agent.length > 0) headers[names.agent] = agent
  if (task.length > 0) headers[names.task] = task
  for (const entry of identity.headers) {
    const name = entry.name.trim()
    if (name.length > 0) headers[name] = entry.value
  }
  return headers
}

/**
 * Estimate a request's token count from its message array. Coarse on purpose:
 * the budget gate only needs to answer "is this conversation already large",
 * and a real tokenizer would tie the plugin to one model family.
 *
 * Heuristic: every CJK character counts as ~0.75 token, every other 4
 * characters as one token, plus a fixed per-message overhead.
 * @param messages - model-visible messages, optionally with block content.
 */
export function estimateTokens(messages: readonly unknown[]): number {
  let cjk = 0
  let other = 0
  const add = (text: string): void => {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      if (isCJK(code)) cjk++
      else other++
    }
  }
  for (const message of messages) {
    if (!isRecord(message)) continue
    const content = message['content']
    if (typeof content === 'string') add(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue
        const text = block['text']
        if (typeof text === 'string') add(text)
      }
    }
  }
  return Math.ceil(cjk * 0.75 + other / 4) + messages.length * 8
}

/** Whether one code point is in a CJK block the estimator treats as dense. */
function isCJK(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xff00 && code <= 0xffef) // fullwidth forms
  )
}

/** Whether a value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}