/**
 * The gate decision: pure, synchronous, and the only place that answers
 * "does this request carry a memory identity?". Kept free of Cordis, of the
 * settings service and of the filesystem so the whole policy — session
 * pinning, the per-model gate, identity resolution — is unit-testable.
 *
 * ## Why a decision is pinned per session
 *
 * The TDAI proxy treats an unidentified request as an interactive form the
 * client cannot fill, and records the resulting session as `bypassed=true` —
 * a **terminal** state: that session then receives no injection and writes no
 * L0, no matter what later requests carry. Flipping a model's gate mid-session
 * (or dropping identity headers after a restart) is therefore not a per-request
 * choice; it permanently retires that conversation's memory.
 *
 * So the first decision taken for a session id is stored, and every later
 * request of that session reuses it verbatim. Configuration changes take
 * effect on new sessions only.
 *
 * @module dsh-memory-gate/gate
 */

import {
  findIdentity,
  identityHeaders,
  isMemoryChain,
  headerNamesIssue,
  pinnedValuesIssue,
  type HeaderNames,
  type IdentityProfile,
  type MemoryGateSection,
  type ModelPick,
} from './identities.js'
import { DSH_SESSION_HEADER, RESERVED_TRANSPORT_HEADERS } from './constants.js'

/** What one request looks like to the gate. */
export interface GateRequest {
  /** Provider route name. */
  provider: string
  /** Exact model id. */
  model: string
  /** The provider profile's base URL, when the settings document names one. */
  baseURL: string | undefined
  /** The harness session id carried by the request, when the caller supplies one. */
  sessionId: string | undefined
  /**
   * Whether this request may create the session's pin. Auxiliary calls
   * (session-title generation, compaction summaries) pass `false`: they must
   * not decide the memory fate of the conversation they summarise, because
   * their model is chosen by a different setting.
   */
  pinnable?: boolean
}

/**
 * The immutable values a pinned attachment reproduces. Editing an identity
 * (or its headers) must not change a session that already pinned it, so the
 * decision stores the values themselves rather than only an identity id.
 */
export interface PinSnapshot {
  /** The identity triple and extra rows as they were when the pin was made. */
  identity: IdentityProfile
  /** The configured identity header names at pin time. */
  headerNames: HeaderNames
  /** Whether the harness session header rode along at pin time. */
  sessionHeader: boolean
}

/** One stored session decision. */
export interface SessionPin {
  /** The pinned identity id, or null when the session runs detached. */
  identity: string | null
  /** Why the pin was created (for the decision log). */
  reason: string
  /** Epoch milliseconds of the first decision. */
  at: number
  /** The provider/model that took the decision (diagnostics only). */
  provider: string
  model: string
  /** The immutable attachment values (absent on a legacy pin, or on a detach). */
  snapshot?: PinSnapshot
  /**
   * The identity header names a detached session must keep deleting. Without
   * them a rename would leave the old names in place, so a detach could never
   * clean up after a previous attachment.
   */
  removeHeaderNames?: HeaderNames
  /**
   * Epoch milliseconds when a legacy id-only pin gained its snapshot. The
   * snapshot can only reflect the configuration at migration time: the values
   * the session originally used were never persisted.
   */
  migratedAt?: number
}

/** What the gate decided for one request. */
export interface GateDecision {
  /**
   * - `skip`: not a memory-chain request; the gate adds nothing.
   * - `detach`: memory-chain request sent **without** identity headers.
   * - `attach`: memory-chain request carrying one identity.
   */
  kind: 'skip' | 'detach' | 'attach'
  /** The identity to apply (`attach` only). */
  identity?: IdentityProfile
  /** The wire headers to add. Empty only for an attach whose identity has no values. */
  headers: Record<string, string>
  /** Core memory headers to delete before stamping (`detach` only). */
  removeHeaders?: string[]
  /** Machine-readable reason (decision log / UI hints). */
  reason:
    | 'not-memory-chain'
    | 'model-detached'
    | 'no-default-identity'
    | 'identity-missing'
    | 'pinned'
    | 'pinned-identity-missing'
    | 'attached'
  /** A pin to store for this session (absent when no session id was supplied). */
  pin?: SessionPin
}

/** Inputs of one decision. */
export interface GateInput {
  request: GateRequest
  section: MemoryGateSection
  /** The model row's pick (already parsed). */
  pick: ModelPick
  /** The pinned decision of this session, when one exists. */
  pin: SessionPin | undefined
  /** Epoch milliseconds, injectable for tests. */
  now: number
}

/** The default identity id, if the section names one that actually exists. */
function defaultIdentityId(section: MemoryGateSection): string | undefined {
  const id = section.defaultIdentity.trim()
  if (id.length === 0) return undefined
  return findIdentity(section, id)?.id
}

/**
 * Assemble the final headers of an attached identity: the identity triple plus
 * extra rows, and (when enabled) the harness session header that lets the
 * proxy key this DSH session as one conversation.
 */
function attachHeaders(
  identity: IdentityProfile,
  names: HeaderNames,
  sessionHeader: boolean,
  sessionId: string | undefined,
): Record<string, string> {
  const headers = identityHeaders(identity, names)
  if (sessionHeader && sessionId !== undefined && sessionId.length > 0) {
    headers[DSH_SESSION_HEADER] = sessionId
  }
  return headers
}

/** Identity ids compare the way {@link findIdentity} compares them. */
function sameId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * The header names to remember for later cleanup, or undefined when they are
 * not usable. Persisting an unusable triple would be silently dropped again by
 * the loader, so the check happens here, at the only place that writes it.
 */
function removalNamesOf(section: MemoryGateSection): HeaderNames | undefined {
  return headerNamesIssue(section.headerNames) === undefined ? { ...section.headerNames } : undefined
}

/**
 * The immutable values a fresh attachment pins: the resolved identity and
 * current shaping, or undefined when those values could never have been saved.
 * Freezing an invalid value would make one session's headers permanently wrong
 * even after the configuration is repaired, so such a request attaches for
 * now but writes no snapshot.
 */
function snapshotOf(identity: IdentityProfile, section: MemoryGateSection): PinSnapshot | undefined {
  if (pinnedValuesIssue(identity, section.headerNames) !== undefined) return undefined
  return {
    // Deep-copy the extra rows: the pin must not alias the configuration object.
    identity: { ...identity, headers: identity.headers.map(entry => ({ ...entry })) },
    headerNames: { ...section.headerNames },
    sessionHeader: section.sessionHeader,
  }
}

/**
 * Decide one request. Pure: no I/O, no clock reading (the caller supplies
 * `now`), no service access.
 * @param input - request facts, the current section, the model pick and any pin.
 * @returns the decision, plus the pin to persist when this request opened a session.
 */
export function decideGate(input: GateInput): GateDecision {
  const { request, section, pick, pin, now } = input
  if (!isMemoryChain(request.baseURL, section.trustedOrigins)) {
    return { kind: 'skip', headers: {}, reason: 'not-memory-chain' }
  }

  const detach = (reason: GateDecision['reason'], withPin: boolean): GateDecision => ({
    kind: 'detach',
    headers: {},
    // Delete every name this plugin may have set: the names the session pinned
    // (even after a rename) plus the current ones. Blank names are dropped —
    // `headers.delete('')` would only produce a noisy warning.
    // Transport headers are filtered out here as well as in validation: with
    // `headerNames.team = 'authorization'` a detach would otherwise delete the
    // caller's own credential. Validation refuses that config, but the
    // composition base only warns, so this path must be safe on its own.
    removeHeaders: [...new Set([
      ...Object.values(pin?.removeHeaderNames ?? {}),
      ...Object.values(section.headerNames),
      DSH_SESSION_HEADER,
    ])].filter(name => name.trim().length > 0
      && !RESERVED_TRANSPORT_HEADERS.includes(name.toLowerCase())),
    reason,
    ...withPin && request.pinnable !== false && request.sessionId !== undefined
      ? {
        pin: {
          identity: null,
          reason,
          at: now,
          provider: request.provider,
          model: request.model,
          ...removalNamesOf(section) === undefined ? {} : { removeHeaderNames: removalNamesOf(section)! },
        },
      }
      : {},
  })

  // A pinned session always wins: the proxy's bypass is terminal, so a later
  // configuration change must not retire a live session's memory.
  if (pin !== undefined) {
    if (pin.identity === null) return detach('pinned', false)
    // A snapshot reproduces the exact values the session pinned. Only a legacy
    // id-only pin is resolved against the live configuration, and it is
    // migrated (once) so later identity edits cannot retroactively change it.
    // The id must agree with the pin: the loader enforces that too, but the
    // gate does not trust a caller to have validated it.
    const snapshot = pin.snapshot !== undefined && sameId(pin.snapshot.identity.id, pin.identity)
      ? pin.snapshot
      : undefined
    if (snapshot !== undefined) {
      return {
        kind: 'attach',
        identity: snapshot.identity,
        headers: attachHeaders(snapshot.identity, snapshot.headerNames, snapshot.sessionHeader, request.sessionId),
        reason: 'pinned',
      }
    }
    const pinned = findIdentity(section, pin.identity)
    if (pinned === undefined) return detach('pinned-identity-missing', false)
    // Migration is a storage repair of the existing decision, not a new one —
    // but only a pinnable request may write pins at all. An invalid live value
    // is left unmigrated so repairing the configuration still repairs the
    // session. `at` keeps its original value; the store orders eviction by the
    // later of `at`/`migratedAt`, so this migration is not the first victim.
    const migrated = request.pinnable !== false ? snapshotOf(pinned, section) : undefined
    return {
      kind: 'attach',
      identity: pinned,
      headers: attachHeaders(pinned, section.headerNames, section.sessionHeader, request.sessionId),
      reason: 'pinned',
      ...migrated === undefined ? {} : { pin: { ...pin, snapshot: migrated, migratedAt: now } },
    }
  }

  if (pick === 'off') return detach('model-detached', true)

  const wanted = pick === 'default' ? defaultIdentityId(section) : pick.identity
  if (wanted === undefined) {
    return detach('no-default-identity', request.sessionId !== undefined)
  }
  const identity = findIdentity(section, wanted)
  if (identity === undefined) return detach('identity-missing', true)

  // An invalid live value is not frozen: the session stays legacy-id-only and
  // is migrated once the configuration is repaired.
  const fresh = snapshotOf(identity, section)
  const pinnable = request.pinnable !== false && request.sessionId !== undefined
  return {
    kind: 'attach',
    identity,
    headers: attachHeaders(identity, section.headerNames, section.sessionHeader, request.sessionId),
    reason: 'attached',
    ...pinnable
      ? {
        pin: {
          identity: identity.id,
          reason: 'attached',
          at: now,
          provider: request.provider,
          model: request.model,
          // Without a valid snapshot the pin is the legacy id-only shape.
          ...fresh === undefined ? {} : { snapshot: fresh },
          // Remember the names even when the values could not be frozen, so a
          // later rename still cleans them up if this identity disappears.
          ...removalNamesOf(section) === undefined ? {} : { removeHeaderNames: removalNamesOf(section)! },
        },
      }
      : {},
  }
}

/** One line for the decision log: the human reading this greps by session. */
export function describeDecision(decision: GateDecision, request: GateRequest): string {
  const head = decision.kind === 'attach'
    ? `attach identity="${decision.identity?.id ?? '?'}"`
    : `${decision.kind} reason=${decision.reason}`
  const where = `${request.provider}/${request.model}`
  const session = request.sessionId === undefined ? 'no-session' : `session=${request.sessionId}`
  return `${head} ${where} ${session}`
}