/**
 * The gate decision matrix: which requests carry a memory identity, why, and
 * when the decision is pinned. Pure logic — no clock, no filesystem, no Cordis.
 */

import { describe, expect, it } from 'vitest'
import { defaultSection, type IdentityProfile, type MemoryGateSection } from '../src/identities.js'
import {
  decideGate,
  describeDecision,
  type GateDecision,
  type GateInput,
  type GateRequest,
  type SessionPin,
} from '../src/gate.js'

const NOW = 1_700_000_000_000
const CHAIN = 'http://127.0.0.1:8096/dsh/default'

/** One identity literal with the given overrides. */
function identity(overrides: Partial<IdentityProfile> = {}): IdentityProfile {
  return { id: 'main', team: 'team-a', agent: 'agent-a', task: 'task-a', headers: [], ...overrides }
}

/** One section literal with the given overrides. */
function section(overrides: Partial<MemoryGateSection> = {}): MemoryGateSection {
  return { ...defaultSection(), identities: [identity()], defaultIdentity: 'main', ...overrides }
}

/** One request literal with the given overrides. */
function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1', estimatedTokens: undefined, ...overrides }
}

/** One pin literal with the given overrides. */
function pin(overrides: Partial<SessionPin> = {}): SessionPin {
  return { identity: 'main', reason: 'attached', at: 1, provider: 'magpie', model: 'm1', ...overrides }
}

/** Run the gate with sensible defaults; every field can be overridden. */
function decide(overrides: Partial<GateInput> = {}): GateDecision {
  return decideGate({
    request: request(),
    section: section(),
    pick: 'default',
    pin: undefined,
    now: NOW,
    ...overrides,
  })
}

describe('non-memory-chain requests', () => {
  it('skip every route that is not the TDAI proxy, whatever the configuration says', () => {
    for (const baseURL of ['https://api.stepfun.com/v1', 'https://api.deepseek.com/v1', undefined]) {
      const decision = decide({ request: request({ baseURL }) })
      expect(decision).toEqual({ kind: 'skip', headers: {}, reason: 'not-memory-chain' })
    }
  })

  it('never pins a skipped session, even with a pick and a budget that would detach', () => {
    const decision = decide({
      request: request({ baseURL: 'https://api.stepfun.com/v1', estimatedTokens: 999_999 }),
      pick: 'off',
      section: section({ budget: { enabled: true, maxRequestTokens: 1 } }),
    })
    expect(decision.pin).toBeUndefined()
  })
})

describe('detaching by model pick', () => {
  it('detaches a model explicitly set to "off" and pins the session as detached', () => {
    const decision = decide({ pick: 'off' })
    expect(decision).toEqual({
      kind: 'detach',
      headers: {},
      reason: 'model-detached',
      pin: { identity: null, reason: 'model-detached', at: NOW, provider: 'magpie', model: 'm1' },
    })
  })

  it('does not pin when the caller supplies no session id', () => {
    const decision = decide({ pick: 'off', request: request({ sessionId: undefined }) })
    expect(decision.pin).toBeUndefined()
    expect(decision.headers).toEqual({})
  })
})

describe('detaching for missing configuration', () => {
  it('detaches when no default identity is configured', () => {
    const decision = decide({ section: section({ defaultIdentity: '' }) })
    expect(decision.kind).toBe('detach')
    expect(decision.reason).toBe('no-default-identity')
    // A session exists, so the decision is pinned: later configuration must
    // not resurrect memory in a session that already ran unidentified.
    expect(decision.pin).toEqual({ identity: null, reason: 'no-default-identity', at: NOW, provider: 'magpie', model: 'm1' })
  })

  it('treats a default identity that does not exist as "no default"', () => {
    const decision = decide({ section: section({ defaultIdentity: 'deleted' }) })
    expect(decision.reason).toBe('no-default-identity')
  })

  it('detaches when the model names an identity that was deleted', () => {
    const decision = decide({ pick: { identity: 'deleted' } })
    expect(decision).toEqual({
      kind: 'detach',
      headers: {},
      reason: 'identity-missing',
      pin: { identity: null, reason: 'identity-missing', at: NOW, provider: 'magpie', model: 'm1' },
    })
  })

  it('does not pin a sessionless missing-configuration decision', () => {
    expect(decide({ section: section({ defaultIdentity: '' }), request: request({ sessionId: undefined }) }).pin)
      .toBeUndefined()
    expect(decide({ pick: { identity: 'deleted' }, request: request({ sessionId: undefined }) }).pin)
      .toBeUndefined()
  })
})

describe('attaching an identity', () => {
  it('attaches the default identity with the triple and the harness session header', () => {
    const decision = decide()
    expect(decision.kind).toBe('attach')
    expect(decision.reason).toBe('attached')
    expect(decision.identity?.id).toBe('main')
    expect(decision.headers).toEqual({
      'x-team-id': 'team-a',
      'x-agent-id': 'agent-a',
      'x-task-id': 'task-a',
      'x-deepseek-harness-session-id': 'session-1',
    })
    expect(decision.pin).toEqual({ identity: 'main', reason: 'attached', at: NOW, provider: 'magpie', model: 'm1' })
  })

  it('honours header-name overrides and extra rows', () => {
    const decision = decide({
      section: section({
        identities: [identity({ headers: [{ name: 'X-Tenant', value: 'acme' }] })],
        headerNames: { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' },
      }),
    })
    expect(decision.headers).toEqual({
      'X-Team': 'team-a',
      'X-Agent': 'agent-a',
      'X-Task': 'task-a',
      'X-Tenant': 'acme',
      'x-deepseek-harness-session-id': 'session-1',
    })
  })

  it('omits the session header when the switch is off', () => {
    const decision = decide({ section: section({ sessionHeader: false }) })
    expect(decision.headers).toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
    expect(decision.headers['x-deepseek-harness-session-id']).toBeUndefined()
  })

  it('omits the session header and the pin when no session id is supplied', () => {
    const decision = decide({ request: request({ sessionId: undefined }) })
    expect(decision.headers).toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
    expect(decision.pin).toBeUndefined()
  })

  it('attaches the identity a model names explicitly, overriding the default', () => {
    const decision = decide({
      pick: { identity: 'Reviewer' },
      section: section({ identities: [identity(), identity({ id: 'reviewer', team: 'team-b', agent: 'agent-b', task: '' })] }),
    })
    expect(decision.identity?.id).toBe('reviewer')
    expect(decision.headers).toEqual({
      'x-team-id': 'team-b',
      'x-agent-id': 'agent-b',
      'x-deepseek-harness-session-id': 'session-1',
    })
    expect(decision.pin?.identity).toBe('reviewer')
  })

  it('resolves the default identity case-insensitively', () => {
    expect(decide({ section: section({ defaultIdentity: ' MAIN ' }) }).identity?.id).toBe('main')
  })
})

describe('the budget gate', () => {
  it('detaches and pins once the estimated request size exceeds the limit', () => {
    const decision = decide({
      section: section({ budget: { enabled: true, maxRequestTokens: 100 } }),
      request: request({ estimatedTokens: 101 }),
    })
    expect(decision).toEqual({
      kind: 'detach',
      headers: {},
      reason: 'budget-exceeded',
      pin: { identity: null, reason: 'budget-exceeded', at: NOW, provider: 'magpie', model: 'm1' },
    })
  })

  it('attaches exactly at the limit (the comparison is strict)', () => {
    const decision = decide({
      section: section({ budget: { enabled: true, maxRequestTokens: 100 } }),
      request: request({ estimatedTokens: 100 }),
    })
    expect(decision.kind).toBe('attach')
  })

  it('does nothing when the budget gate is disabled or no estimate was observed', () => {
    expect(decide({ request: request({ estimatedTokens: 999_999 }) }).kind).toBe('attach')
    expect(decide({
      section: section({ budget: { enabled: true, maxRequestTokens: 1 } }),
      request: request({ estimatedTokens: undefined }),
    }).kind).toBe('attach')
  })

  it('detaches a session that has no session id without pinning', () => {
    const decision = decide({
      section: section({ budget: { enabled: true, maxRequestTokens: 1 } }),
      request: request({ sessionId: undefined, estimatedTokens: 2 }),
    })
    expect(decision.reason).toBe('budget-exceeded')
    expect(decision.pin).toBeUndefined()
  })
})

describe('the pinned decision of a session', () => {
  it('reuses a pinned attachment even after the model pick changed to "off"', () => {
    // This is the reason pinning exists: the proxy's `bypassed` state is
    // terminal, so flipping the pick mid-session must not retire memory.
    const decision = decide({ pin: pin(), pick: 'off' })
    expect(decision.kind).toBe('attach')
    expect(decision.reason).toBe('pinned')
    expect(decision.headers['x-team-id']).toBe('team-a')
    expect(decision.headers['x-deepseek-harness-session-id']).toBe('session-1')
    // No new pin: the existing one stays authoritative.
    expect(decision.pin).toBeUndefined()
  })

  it('reuses a pinned attachment even after the budget would now detach', () => {
    const decision = decide({
      pin: pin(),
      section: section({ budget: { enabled: true, maxRequestTokens: 1 } }),
      request: request({ estimatedTokens: 1000 }),
    })
    expect(decision.reason).toBe('pinned')
    expect(decision.kind).toBe('attach')
  })

  it('resolves the pinned identity case-insensitively and uses the current header names', () => {
    const decision = decide({
      pin: pin({ identity: 'MAIN' }),
      section: section({ headerNames: { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' } }),
    })
    expect(decision.identity?.id).toBe('main')
    expect(decision.headers['X-Team']).toBe('team-a')
  })

  it('keeps a pinned detachment detached, without re-pinning', () => {
    const decision = decide({ pin: pin({ identity: null, reason: 'model-detached' }) })
    expect(decision).toEqual({ kind: 'detach', headers: {}, reason: 'pinned' })
  })

  it('keeps a session detached when the pinned identity was deleted', () => {
    const decision = decide({ pin: pin({ identity: 'deleted' }), pick: 'default' })
    expect(decision).toEqual({ kind: 'detach', headers: {}, reason: 'pinned-identity-missing' })
  })

  it('lets a pin override a model that names another existing identity', () => {
    const decision = decide({
      pin: pin({ identity: 'main' }),
      pick: { identity: 'reviewer' },
      section: section({ identities: [identity(), identity({ id: 'reviewer' })] }),
    })
    expect(decision.identity?.id).toBe('main')
    expect(decision.reason).toBe('pinned')
  })
})

describe('auxiliary (non-pinnable) calls', () => {
  it('attaches headers for the call but creates no pin', () => {
    // Title generation / compaction calls must not register the session: the
    // proxy's decision is terminal, so only the main request may open it.
    const decision = decide({ request: request({ pinnable: false }) })
    expect(decision.kind).toBe('attach')
    expect(decision.headers['x-team-id']).toBe('team-a')
    expect(decision.headers['x-deepseek-harness-session-id']).toBe('session-1')
    expect(decision.pin).toBeUndefined()
  })

  it('detaches without pinning, leaving a later main request free to decide', () => {
    const decision = decide({ request: request({ pinnable: false }), pick: 'off' })
    expect(decision.kind).toBe('detach')
    expect(decision.reason).toBe('model-detached')
    expect(decision.pin).toBeUndefined()
  })

  it('does not pin a budget detachment or a missing identity either', () => {
    for (const input of [
      {
        request: request({ pinnable: false, estimatedTokens: 500 }),
        section: section({ budget: { enabled: true, maxRequestTokens: 1 } }),
      },
      { request: request({ pinnable: false }), section: section({ defaultIdentity: '' }) },
      { request: request({ pinnable: false }), pick: { identity: 'deleted' } as const },
    ]) {
      expect(decide(input).pin).toBeUndefined()
    }
  })

  it('reuses an existing pin unchanged', () => {
    const decision = decide({ request: request({ pinnable: false }), pin: pin(), pick: 'off' })
    expect(decision.kind).toBe('attach')
    expect(decision.reason).toBe('pinned')
    expect(decision.pin).toBeUndefined()
  })

  it('treats pinnable: true and an omitted flag the same', () => {
    expect(decide({ request: request({ pinnable: true }) }).pin).toBeDefined()
    expect(decide({ request: request() }).pin).toBeDefined()
  })
})

describe('describeDecision', () => {
  it('names the identity and place of an attachment', () => {
    expect(describeDecision(decide(), request())).toBe('attach identity="main" magpie/m1 session=session-1')
  })

  it('names the reason of a detachment', () => {
    expect(describeDecision(decide({ pick: 'off' }), request())).toBe('detach reason=model-detached magpie/m1 session=session-1')
  })

  it('marks a request without a session id', () => {
    expect(describeDecision(decide(), request({ sessionId: undefined }))).toBe('attach identity="main" magpie/m1 no-session')
  })
})