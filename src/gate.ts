/**
 * The gate decision: pure, synchronous, and the only place that answers
 * "does this request carry a memory identity?". Kept free of Cordis, of the
 * settings service and of the filesystem so the whole policy — session
 * pinning, the budget detachment, identity resolution — is unit-testable.
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
  type IdentityProfile,
  type MemoryGateSection,
  type ModelPick,
} from './identities.js'

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
  /** Coarse token estimate of this request, when a stream listener observed it. */
  estimatedTokens: number | undefined
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
  /** The wire headers to add (never empty for `attach`). */
  headers: Record<string, string>
  /** Machine-readable reason (decision log / UI hints). */
  reason:
    | 'not-memory-chain'
    | 'model-detached'
    | 'no-default-identity'
    | 'identity-missing'
    | 'budget-exceeded'
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

/** Whether the budget gate detaches this request. */
function budgetExceeded(section: MemoryGateSection, request: GateRequest): boolean {
  if (!section.budget.enabled) return false
  if (request.estimatedTokens === undefined) return false
  return request.estimatedTokens > section.budget.maxRequestTokens
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
  section: MemoryGateSection,
  sessionId: string | undefined,
): Record<string, string> {
  const headers = identityHeaders(identity, section.headerNames)
  if (section.sessionHeader && sessionId !== undefined && sessionId.length > 0) {
    headers['x-deepseek-harness-session-id'] = sessionId
  }
  return headers
}

/**
 * Decide one request. Pure: no I/O, no clock reading (the caller supplies
 * `now`), no service access.
 * @param input - request facts, the current section, the model pick and any pin.
 * @returns the decision, plus the pin to persist when this request opened a session.
 */
export function decideGate(input: GateInput): GateDecision {
  const { request, section, pick, pin, now } = input
  if (!isMemoryChain(request.baseURL)) {
    return { kind: 'skip', headers: {}, reason: 'not-memory-chain' }
  }

  const detach = (reason: GateDecision['reason'], withPin: boolean): GateDecision => ({
    kind: 'detach',
    headers: {},
    reason,
    ...withPin && request.pinnable !== false && request.sessionId !== undefined
      ? { pin: { identity: null, reason, at: now, provider: request.provider, model: request.model } }
      : {},
  })

  // A pinned session always wins: the proxy's bypass is terminal, so a later
  // configuration change must not retire a live session's memory.
  if (pin !== undefined) {
    if (pin.identity === null) return detach('pinned', false)
    const pinned = findIdentity(section, pin.identity)
    if (pinned === undefined) return detach('pinned-identity-missing', false)
    return { kind: 'attach', identity: pinned, headers: attachHeaders(pinned, section, request.sessionId), reason: 'pinned' }
  }

  if (pick === 'off') return detach('model-detached', true)

  // The first decision of a memory-chain session is the one that registers it;
  // the budget gate may only run here, never later.
  const exceedsBudget = budgetExceeded(section, request)
  if (exceedsBudget) return detach('budget-exceeded', true)

  const wanted = pick === 'default' ? defaultIdentityId(section) : pick.identity
  if (wanted === undefined) {
    return detach('no-default-identity', request.sessionId !== undefined)
  }
  const identity = findIdentity(section, wanted)
  if (identity === undefined) return detach('identity-missing', true)

  return {
    kind: 'attach',
    identity,
    headers: attachHeaders(identity, section, request.sessionId),
    reason: 'attached',
    ...request.pinnable !== false && request.sessionId !== undefined
      ? { pin: { identity: identity.id, reason: 'attached', at: now, provider: request.provider, model: request.model } }
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