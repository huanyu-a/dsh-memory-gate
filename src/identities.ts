/**
 * Pure memory-gate logic shared by the host and browser halves: the identity
 * section shape, its validation (case-insensitive id uniqueness, Fetch-valid
 * header names), the per-model pick, call-time header assembly, memory-chain
 * recognition and call-time header assembly.
 *
 * No Cordis, no DOM, no Node APIs — every function here is unit-testable in
 * isolation and safe to import from the browser half.
 *
 * @module dsh-memory-header-gate/identities
 */

import {
  CONFIGURED_HEADER_FIELDS,
  RESERVED_TRANSPORT_HEADERS,
  DEFAULT_AGENT_HEADER,
  DEFAULT_TASK_HEADER,
  DEFAULT_TEAM_HEADER,
  DSH_SESSION_HEADER,
  DEFAULT_TRUSTED_ORIGINS,
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

/** The `memory-gate` settings section this plugin owns. */
export interface MemoryGateSection {
  identities: IdentityProfile[]
  /** Exact HTTP(S) origins permitted to receive identity and session headers; [] denies all. */
  trustedOrigins: string[]
  /** Identity id every model inherits unless it names another one; empty = no default. */
  defaultIdentity: string
  headerNames: HeaderNames
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
    trustedOrigins: [...DEFAULT_TRUSTED_ORIGINS],
    defaultIdentity: '',
    headerNames: { team: DEFAULT_TEAM_HEADER, agent: DEFAULT_AGENT_HEADER, task: DEFAULT_TASK_HEADER },
    sessionHeader: true,
  }
}

/** A validation finding, addressed by identity index and (for rows) row index. */
export interface IdentityIssue {
  /** Index of the offending identity in the section. */
  identity: number
  /** Index of the offending header row; absent for identity-level findings. */
  row?: number
  code: 'id-empty' | 'id-duplicate' | 'team-empty' | 'name-empty' | 'name-invalid' | 'name-reserved'
    | 'name-conflict' | 'name-duplicate' | 'value-invalid'
  /** Offending value; for `value-invalid`, only the field/header name, never its potentially secret value. */
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
  return {
    identities,
    // Preserve invalid entries for validation rather than silently trusting the default.
    trustedOrigins: value['trustedOrigins'] === undefined
      ? base.trustedOrigins
      : Array.isArray(value['trustedOrigins'])
        ? value['trustedOrigins'].map(origin => typeof origin === 'string' ? trustedOrigin(origin) ?? origin : '')
        : [''],
    defaultIdentity: typeof value['defaultIdentity'] === 'string' ? value['defaultIdentity'] : '',
    headerNames: {
      team: nonEmptyString(names['team']) ?? base.headerNames.team,
      agent: nonEmptyString(names['agent']) ?? base.headerNames.agent,
      task: nonEmptyString(names['task']) ?? base.headerNames.task,
    },
    sessionHeader: value['sessionHeader'] === false ? false : base.sessionHeader,
  }
}

/** Validate one identity list, returning every finding (empty when valid). */
export function validateIdentities(section: MemoryGateSection): IdentityIssue[] {
  const issues: IdentityIssue[] = []
  // These ids are model-pick sentinels, not selectable named identities.
  const seen = new Set(['off', 'default'])
  section.identities.forEach((identity, at) => {
    const id = identity.id.trim()
    if (id.length === 0) {
      issues.push({ identity: at, code: 'id-empty', value: identity.id })
    } else {
      const key = id.toLowerCase()
      if (seen.has(key)) issues.push({ identity: at, code: 'id-duplicate', value: id })
      else seen.add(key)
    }
    if (identity.team.trim().length === 0) issues.push({ identity: at, code: 'team-empty', value: id })
    for (const field of ['team', 'agent', 'task'] as const) {
      if (!fetchAcceptsValue(identity[field])) issues.push({ identity: at, code: 'value-invalid', value: field })
    }
    const seenNames = new Set<string>()
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
      } else if (CONFIGURED_HEADER_FIELDS.some(field => section.headerNames[field].toLowerCase() === name.toLowerCase())) {
        // The identity's own team/agent/task header would be overwritten by
        // this row, so the value shown in the editor would not be the value on
        // the wire. Reject it instead of silently preferring one of the two.
        issues.push({ identity: at, row, code: 'name-conflict', value: name })
      } else if (name.toLowerCase() === DSH_SESSION_HEADER.toLowerCase()) {
        // The session header is the conversation key. A configurable row must
        // never supply it: with the session-header switch off, one constant
        // value would merge every session into a single proxy conversation.
        issues.push({ identity: at, row, code: 'name-reserved', value: name })
      } else if (seenNames.has(name.toLowerCase())) {
        // Two rows on one name would either silently drop the first value or,
        // when the casing differs, put two values on the wire for one header
        // (HTTP names are case-insensitive).
        issues.push({ identity: at, row, code: 'name-duplicate', value: name })
      } else if (!fetchAcceptsValue(entry.value)) {
        issues.push({ identity: at, row, code: 'value-invalid', value: name })
      } else {
        seenNames.add(name.toLowerCase())
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
  if (!Array.isArray(section.trustedOrigins) || section.trustedOrigins.some(origin => trustedOrigin(origin) === undefined)) {
    throw new Error('memory-gate: trustedOrigins must contain only HTTP(S) origins without credentials, query, hash, or path')
  }
  const seenNames = new Set<string>()
  for (const field of ['team', 'agent', 'task'] as const) {
    const name = section.headerNames[field]
    if (!fetchAcceptsName(name)) {
      throw new Error(`memory-gate: headerNames.${field} must be a valid HTTP header name`)
    }
    const key = name.toLowerCase()
    if (seenNames.has(key)) {
      throw new Error(`memory-gate: headerNames.${field} duplicates another configured header name (names are case-insensitive)`)
    }
    if (key === DSH_SESSION_HEADER.toLowerCase()) {
      throw new Error(`memory-gate: headerNames.${field} collides with the reserved session header "${DSH_SESSION_HEADER}"`)
    }
    if (RESERVED_TRANSPORT_HEADERS.includes(key)) {
      throw new Error(`memory-gate: headerNames.${field} must not be "${name}": a transport header there would overwrite the caller's own value on attach and be deleted on detach`)
    }
    seenNames.add(key)
  }
  if (section.defaultIdentity.trim().length > 0 && findIdentity(section, section.defaultIdentity) === undefined) {
    throw new Error('memory-gate: defaultIdentity must name a configured identity')
  }
  const issue = validateIdentities(section)[0]
  if (issue === undefined) return
  const where = issue.row === undefined
    ? `identity #${String(issue.identity + 1)}`
    : `identity #${String(issue.identity + 1)} header row #${String(issue.row + 1)}`
  const reason = {
    'id-empty': 'needs an id',
    'id-duplicate': ['off', 'default'].includes(issue.value.toLowerCase())
      ? `uses the reserved model-pick id "${issue.value}"`
      : `duplicates the id "${issue.value}" (ids are case-insensitive)`,
    'team-empty': 'needs a team id: the proxy treats a teamless request as unidentified and can never inject memory for it',
    'name-empty': 'has a value but no header name',
    'name-invalid': `uses "${issue.value}", which is not a representable HTTP header name`,
    'name-reserved': `uses "${issue.value}", the header that carries the session id: a configured row must not choose the conversation key`,
    'name-conflict': `uses "${issue.value}", which is also the header name the identity's own team/agent/task field is sent under: the row would silently replace that value`,
    'name-duplicate': `repeats the header name "${issue.value}" (names are case-insensitive): only one of the two values could ever be sent`,
    'value-invalid': `has a value that cannot be sent as an HTTP header ("${issue.value}")`,
  }[issue.code]
  throw new Error(`memory-gate: ${where} ${reason}`)
}

/**
 * Validate one attachment's values with exactly the rules the settings write
 * path enforces, so a value that could never be saved cannot be frozen into a
 * pin either. Returns the human reason when invalid, undefined when the values
 * are safe to persist and replay verbatim.
 * @param identity - the identity to pin.
 * @param names - the header names it will be sent under.
 */
export function pinnedValuesIssue(identity: IdentityProfile, names: HeaderNames): string | undefined {
  try {
    assertValidSection({
      ...defaultSection(),
      identities: [identity],
      defaultIdentity: identity.id,
      // The header names are part of the pinned values, so validate them too:
      // a snapshot may not key the conversation through the reserved session
      // header, collide two triples, or carry an unrepresentable name.
      headerNames: { ...names },
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Validate the three configured header names on their own, with the same rules
 * the settings write path applies. Callers that persist names for later
 * deletion use this so they never store a triple the loader would refuse.
 * @param names - the header names to check.
 * @returns the human reason when invalid, undefined when the names are usable.
 */
export function headerNamesIssue(names: HeaderNames): string | undefined {
  const probe: IdentityProfile = { id: 'probe', team: 'probe', agent: '', task: '', headers: [] }
  return pinnedValuesIssue(probe, names)
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

/** Parse an HTTP(S) URL without credentials, rejecting non-URL and control-character input. */
function requestURL(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username) return undefined
    // Even empty userinfo is not an approved request URL.
    if (value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0]?.includes('@')) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Normalize a configured origin, permitting only an optional trailing slash. */
function trustedOrigin(value: unknown): string | undefined {
  const url = requestURL(value)
  if (!url || typeof value !== 'string' || url.pathname !== '/' || value.includes('?') || value.includes('#')) return undefined
  // Inspect the raw suffix too: URL parsing otherwise erases dot segments.
  const suffix = value.slice(value.indexOf('//') + 2).replace(/^[^/]+/, '')
  return suffix === '' || suffix === '/' ? url.origin : undefined
}

/** Match only an explicitly trusted origin; path/hostname heuristics never grant trust. */
export function isMemoryChain(baseURL: string | undefined, trustedOrigins: readonly string[] = DEFAULT_TRUSTED_ORIGINS): boolean {
  const url = requestURL(baseURL)
  if (!url || !Array.isArray(trustedOrigins)) return false
  return trustedOrigins.some(origin => trustedOrigin(origin) === url.origin)
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
  for (const entry of identity.headers) {
    const name = entry.name.trim()
    // The session header is the conversation key. It is enforced at every write
    // path, but this function is also reachable with a composition-base value
    // that bypassed validation, so the reservation is re-asserted here: a
    // constant key would merge every session into one proxy conversation.
    // Drop a row that reuses a configured or session header name: HTTP names
    // are case-insensitive, so keeping both would put two values on the wire
    // for one header. Validation rejects such rows; this guards the path that
    // bypassed it.
    const owned = CONFIGURED_HEADER_FIELDS.some(field => names[field].toLowerCase() === name.toLowerCase())
    if (name.length === 0 || owned || name.toLowerCase() === DSH_SESSION_HEADER.toLowerCase()) continue
    // One value per name: a repeated row is rejected by validation, and the
    // first spelling wins here so a bypassed config still sends one header.
    if (Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) continue
    headers[name] = entry.value
  }
  // The identity's own fields are written last so they win: validation rejects
  // a row that reuses one of these names (`name-conflict`), and a value that
  // slipped past validation must still not replace the team/agent/task the
  // editor shows.
  const team = identity.team.trim()
  const agent = identity.agent.trim()
  const task = identity.task.trim()
  // A configured name equal to the session header is rejected at every write
  // path, but the composition base only produces a startup warning and is still
  // used. Writing the team value there with the session-header switch off would
  // make one constant value the conversation key, merging every session into a
  // single proxy conversation; with the switch on it would drop the team
  // instead. Neither is acceptable, so the name is treated as unusable and the
  // request simply carries no identity header (the proxy then injects nothing).
  const usable = (name: string): boolean => {
    const key = name.toLowerCase()
    return key !== DSH_SESSION_HEADER.toLowerCase() && !RESERVED_TRANSPORT_HEADERS.includes(key)
  }
  // One value per header name: the three configured names are validated to be
  // distinct, but that check lives in `assertValidSection`, which the
  // composition base only reaches as a startup warning. Two names differing
  // only by case would otherwise put two values on one header.
  const used = new Set<string>()
  const place = (name: string, value: string): void => {
    if (value.length === 0 || !usable(name)) return
    const key = name.toLowerCase()
    if (used.has(key)) return
    used.add(key)
    headers[name] = value
  }
  place(names.team, team)
  place(names.agent, agent)
  place(names.task, task)
  return headers
}

/** Whether a value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}