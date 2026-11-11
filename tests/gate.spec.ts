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
  return { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 'session-1', ...overrides }
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

  it.each([
    'http://other.example:8096/v1', 'https://memory.example/v1', 'https://tdai.example/v1',
    'https://evil.example/path/:8096/', 'http://127.0.0.1.evil.example:8096/v1',
    'http://user:secret@127.0.0.1:8096/v1', 'http://127.0.0.1:8097/v1',
    'https://127.0.0.1:8096/v1', 'ftp://127.0.0.1:8096/v1', 'not a URL',
  ])('never attaches headers or reuses a pin for untrusted URL %j', baseURL => {
    expect(decide({ request: request({ baseURL }), pin: pin() }))
      .toEqual({ kind: 'skip', headers: {}, reason: 'not-memory-chain' })
  })

  it('honors explicit origins rather than the default', () => {
    const configured = section({ trustedOrigins: ['https://proxy.example:8443'] })
    expect(decide({ section: configured, request: request({ baseURL: 'https://proxy.example:8443/v1' }) }).kind).toBe('attach')
    expect(decide({ section: configured }).kind).toBe('skip')
  })

  it('denies all origins when configured empty, including pinned requests', () => {
    expect(decide({ section: section({ trustedOrigins: [] }), pin: pin() }))
      .toEqual({ kind: 'skip', headers: {}, reason: 'not-memory-chain' })
  })

  it('never pins a skipped session, even when the model pick would detach', () => {
    const decision = decide({
      request: request({ baseURL: 'https://api.stepfun.com/v1' }),
      pick: 'off',
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
      removeHeaders: ['x-team-id', 'x-agent-id', 'x-task-id', 'x-deepseek-harness-session-id'],
      reason: 'model-detached',
      pin: {
        identity: null,
        reason: 'model-detached',
        at: NOW,
        provider: 'magpie',
        model: 'm1',
        removeHeaderNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
      },
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
    expect(decision.pin).toMatchObject({
      identity: null,
      reason: 'no-default-identity',
      removeHeaderNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
    })
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
      removeHeaders: ['x-team-id', 'x-agent-id', 'x-task-id', 'x-deepseek-harness-session-id'],
      reason: 'identity-missing',
      pin: {
        identity: null,
        reason: 'identity-missing',
        at: NOW,
        provider: 'magpie',
        model: 'm1',
        removeHeaderNames: { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
      },
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
    expect(decision.pin).toMatchObject({ identity: 'main', reason: 'attached', at: NOW, provider: 'magpie', model: 'm1' })
    // A fresh attachment persists the values it used, not just the identity id.
    expect(decision.pin?.snapshot).toEqual({
      identity: identity(),
      headerNames: defaultSection().headerNames,
      sessionHeader: true,
    })
    expect(decision.pin?.migratedAt).toBeUndefined()
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

describe('the pinned decision of a session', () => {
  it('reuses a pinned attachment even after the model pick changed to "off"', () => {
    // This is the reason pinning exists: the proxy's `bypassed` state is
    // terminal, so flipping the pick mid-session must not retire memory.
    const decision = decide({ pin: pin(), pick: 'off' })
    expect(decision.kind).toBe('attach')
    expect(decision.reason).toBe('pinned')
    expect(decision.headers['x-team-id']).toBe('team-a')
    expect(decision.headers['x-deepseek-harness-session-id']).toBe('session-1')
    // A legacy id-only pin is migrated in place; nothing else changes.
    expect(decision.pin).toMatchObject({ identity: 'main', at: 1, reason: 'attached', migratedAt: NOW })
  })

  it('records the header names on a new pin, and nothing at all when they are unusable', () => {
    // Write/read symmetry: the loader rejects an unusable triple, so the gate
    // must not persist one either — otherwise a rename would lose the cleanup.
    const good = decide({ request: { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 's' } })
    expect(good.pin?.removeHeaderNames).toEqual({ team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' })

    const invalid = decide({
      request: { provider: 'magpie', model: 'm1', baseURL: CHAIN, sessionId: 's' },
      // A case-insensitive duplicate: the settings writer refuses it outright.
      section: section({ headerNames: { team: 'X-Id', agent: 'x-id', task: 'x-task-id' } }),
    })
    expect(invalid.kind).toBe('attach')
    expect(invalid.pin?.snapshot).toBeUndefined()
    expect(invalid.pin?.removeHeaderNames).toBeUndefined()
  })

  it('ignores a snapshot whose identity disagrees with the pin', () => {
    // Defence in depth: the loader already drops such a snapshot, but a pin
    // built by another caller must not attach an identity it never chose.
    const decision = decide({
      pin: {
        ...pin({ identity: 'main' }),
        snapshot: {
          identity: identity({ id: 'intruder', team: 'evil' }),
          headerNames: defaultSection().headerNames,
          sessionHeader: true,
        },
      },
    })
    expect(decision.kind).toBe('attach')
    expect(decision.headers['x-team-id']).toBe('team-a')
    expect(decision.headers['x-agent-id']).toBe('agent-a')
  })

  it('does not freeze an invalid live value into a new pin', () => {
    // A composition-base value that never met the write validator must stay
    // repairable: the request attaches now, but nothing is snapshot.
    const decision = decide({ section: section({ identities: [identity({ team: '  ' })] }) })
    expect(decision.kind).toBe('attach')
    expect(decision.pin).toMatchObject({ identity: 'main' })
    expect(decision.pin?.snapshot).toBeUndefined()
  })

  it('refuses to snapshot header names the settings write path would reject', () => {
    const decision = decide({
      section: section({ headerNames: { team: 'x-deepseek-harness-session-id', agent: 'x-agent-id', task: 'x-task-id' } }),
    })
    expect(decision.kind).toBe('attach')
    expect(decision.pin?.snapshot).toBeUndefined()
  })

  it('leaves a legacy pin unmigrated while the live value is invalid', () => {
    // Otherwise a transient misconfiguration would become permanent for this
    // session, and repairing the config could no longer repair it.
    const decision = decide({ pin: pin(), section: section({ identities: [identity({ headers: [{ name: 'bad name', value: 'v' }] })] }) })
    expect(decision.kind).toBe('attach')
    expect(decision.pin).toBeUndefined()
  })

  it('migrates a legacy pin without refreshing its original decision time', () => {
    // Keeping `at` matters: pruning keeps the newest pins, so a migration that
    // stamped a fresh time could keep a pin the store would otherwise evict —
    // and refreshing it is not this decision's business either way.
    const decision = decide({ pin: pin({ at: 5 }) })
    expect(decision.pin?.at).toBe(5)
    expect(decision.pin?.migratedAt).toBe(NOW)
  })

  it('reproduces pinned values after the identity and shaping changed', () => {
    // The core of the snapshot contract: editing config must not rewrite a
    // live session's identity, header names or session-header switch.
    const decision = decide({
      pin: {
        ...pin(),
        snapshot: {
          identity: identity({ team: 'old-team', headers: [{ name: 'X-Old', value: 'v1' }] }),
          headerNames: { team: 'X-Old-Team', agent: 'X-Old-Agent', task: 'X-Old-Task' },
          sessionHeader: false,
        },
      },
      section: section({
        identities: [identity({ team: 'new-team' })],
        headerNames: { team: 'X-New-Team', agent: 'X-New-Agent', task: 'X-New-Task' },
        sessionHeader: true,
      }),
    })
    expect(decision.kind).toBe('attach')
    expect(decision.reason).toBe('pinned')
    expect(decision.headers).toEqual({
      'X-Old-Team': 'old-team',
      'X-Old-Agent': 'agent-a',
      'X-Old-Task': 'task-a',
      'X-Old': 'v1',
    })
    // Already snapshotted: the pin is authoritative and writes nothing.
    expect(decision.pin).toBeUndefined()
  })

  it('still attaches a snapshot whose identity was deleted from the configuration', () => {
    const decision = decide({
      pin: {
        ...pin({ identity: 'gone' }),
        snapshot: { identity: identity({ id: 'gone' }), headerNames: defaultSection().headerNames, sessionHeader: true },
      },
      section: section({ identities: [identity({ id: 'other' })], defaultIdentity: 'other' }),
    })
    expect(decision.kind).toBe('attach')
    expect(decision.headers['x-team-id']).toBe('team-a')
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
    expect(decision).toEqual({ kind: 'detach', headers: {}, reason: 'pinned', removeHeaders: ['x-team-id', 'x-agent-id', 'x-task-id', 'x-deepseek-harness-session-id'] })
  })

  it('never deletes a transport header, even when the config names one', () => {
    // Validation refuses such a config, but the composition base only warns,
    // so detach must be safe on its own: deleting `authorization` here would
    // strip the caller's own credential.
    const decision = decide({
      pick: 'off',
      section: section({ headerNames: { team: 'authorization', agent: 'x-agent-id', task: 'x-task-id' } }),
    })
    const removed = (decision.removeHeaders ?? []).map(name => name.toLowerCase())
    expect(removed).not.toContain('authorization')
    expect(removed).toContain('x-agent-id')
  })

  it('removes the session header even when this plugin never set it', () => {
    // Deliberate: the harness itself adds `x-deepseek-harness-session-id` on
    // Anthropic-shaped requests, so a detach that left it in place could let
    // the proxy still attribute the call to a session. Detach is the one path
    // where "carry no memory identity" wins over leaving foreign headers alone.
    const off = section({ sessionHeader: false })
    expect(decide({ pick: 'off', section: off }).removeHeaders).toContain('x-deepseek-harness-session-id')
    // …while an attach with the switch off does not add that header.
    expect(decide({ pick: 'default', section: off }).headers).not.toHaveProperty('x-deepseek-harness-session-id')
  })

  it('keeps deleting the header names a detached session pinned before a rename', () => {
    // The pin remembers the names it detached under, so renaming the config
    // cannot leave the old names (and their stale values) behind.
    const decision = decide({
      pin: pin({
        identity: null,
        reason: 'model-detached',
        removeHeaderNames: { team: 'X-Old-Team', agent: 'X-Old-Agent', task: 'X-Old-Task' },
      }),
      section: section({ headerNames: { team: 'X-New-Team', agent: 'X-New-Agent', task: 'X-New-Task' } }),
    })
    expect(decision.removeHeaders).toEqual([
      'X-Old-Team', 'X-Old-Agent', 'X-Old-Task',
      'X-New-Team', 'X-New-Agent', 'X-New-Task',
      'x-deepseek-harness-session-id',
    ])
  })

  it('keeps a session detached when the pinned identity was deleted', () => {
    const decision = decide({ pin: pin({ identity: 'deleted' }), pick: 'default' })
    expect(decision).toEqual({ kind: 'detach', headers: {}, reason: 'pinned-identity-missing', removeHeaders: ['x-team-id', 'x-agent-id', 'x-task-id', 'x-deepseek-harness-session-id'] })
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

  it('does not pin a missing identity either', () => {
    for (const input of [
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
    // An auxiliary call must never migrate a legacy pin: pins are the main
    // request's to write.
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