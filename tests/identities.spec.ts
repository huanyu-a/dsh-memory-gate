/**
 * Pure identity logic: section defaults and coercion, write-time validation
 * (case-insensitive id uniqueness, Fetch-representable header names/values),
 * call-time header assembly, memory-chain recognition, and the model-row pick reader.
 *
 * Every function here is shared by the host and browser halves, so these tests
 * are the contract both halves rely on.
 */

import { describe, expect, it } from 'vitest'
import { DSH_SESSION_HEADER } from '../src/constants.js'
import {
  defaultSection,
  findIdentity,
  identityFromUnknown,
  identityHeaders,
  isMemoryChain,
  isRecord,
  modelPickOf,
  modelsOf,
  normalizeSection,
  parsePick,
  providerBaseURL,
  validateIdentities,
  assertValidSection,
  type HeaderNames,
  type IdentityProfile,
  type MemoryGateSection,
} from '../src/identities.js'

/** The default header names, spelled out so a constants drift fails loudly. */
const NAMES: HeaderNames = { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' }

/** One identity literal with the given overrides. */
function identity(overrides: Partial<IdentityProfile> = {}): IdentityProfile {
  return { id: 'main', team: 'team-a', agent: 'agent-a', task: 'task-a', headers: [], ...overrides }
}

/** One section literal with the given overrides. */
function section(overrides: Partial<MemoryGateSection> = {}): MemoryGateSection {
  return { ...defaultSection(), ...overrides }
}

describe('defaultSection', () => {
  it('starts empty and teamless', () => {
    expect(defaultSection()).toEqual({
      identities: [],
      trustedOrigins: ['http://127.0.0.1:8096'],
      defaultIdentity: '',
      headerNames: NAMES,
      sessionHeader: true,
    })
  })

  it('hands out fresh objects, so one caller cannot mutate another’s defaults', () => {
    const first = defaultSection()
    first.identities.push(identity())
    first.headerNames.team = 'x-evil'
    first.trustedOrigins.length = 0
    expect(defaultSection().trustedOrigins).toEqual(['http://127.0.0.1:8096'])
    expect(defaultSection().identities).toEqual([])
    expect(defaultSection().headerNames.team).toBe('x-team-id')
  })
})

describe('normalizeSection', () => {
  it('answers the defaults for a missing or non-record document', () => {
    expect(normalizeSection(undefined)).toEqual(defaultSection())
    expect(normalizeSection(null)).toEqual(defaultSection())
    expect(normalizeSection('garbage')).toEqual(defaultSection())
    expect(normalizeSection([])).toEqual(defaultSection())
  })

  it('defaults only missing origins, preserves deny-all, and normalizes valid origins', () => {
    expect(normalizeSection({}).trustedOrigins).toEqual(['http://127.0.0.1:8096'])
    expect(normalizeSection({ trustedOrigins: [] }).trustedOrigins).toEqual([])
    expect(normalizeSection({ trustedOrigins: ['HTTPS://Memory.Example:443/'] }).trustedOrigins).toEqual(['https://memory.example'])
  })

  it.each([null, 'https://example.com', [42], [''], ['not a URL'], ['ftp://example.com'],
    ['http://user:secret@example.com'], ['http://@example.com'], ['https://example.com/path'],
    ['https://example.com/a/..'], ['https://example.com/?'], ['https://example.com/#']])('preserves invalid origins for validation: %j', trustedOrigins => {
    expect(() => { assertValidSection(normalizeSection({ trustedOrigins })) }).toThrow(/trustedOrigins/)
  })

  it('keeps identities as staged, coercing unrepresentable fields instead of dropping them', () => {
    const out = normalizeSection({
      identities: [
        {
          id: ' team-a ',
          team: 'T',
          agent: 42,
          task: undefined,
          headers: [{ name: 'X-A', value: '1' }, 'junk', { name: 3, value: 'v' }],
        },
        'garbage',
      ],
    })
    // Ids are NOT trimmed here: the editor/validation stage decides that, and
    // dropping silently would hide duplicate-id findings from the user.
    expect(out.identities).toEqual([
      { id: ' team-a ', team: 'T', agent: '', task: '', headers: [{ name: 'X-A', value: '1' }, { name: '', value: 'v' }] },
      { id: '', team: '', agent: '', task: '', headers: [] },
    ])
  })

  it('answers no identities when the list is malformed', () => {
    expect(normalizeSection({ identities: 'nope' }).identities).toEqual([])
    expect(normalizeSection({ identities: { 0: identity() } }).identities).toEqual([])
  })

  it('trims header-name overrides and falls back to the proxy defaults per field', () => {
    const out = normalizeSection({ headerNames: { team: '  X-Team  ', agent: '', task: 42 } })
    expect(out.headerNames).toEqual({ team: 'X-Team', agent: 'x-agent-id', task: 'x-task-id' })
  })

  it('treats only an explicit false as "do not send the session header"', () => {
    expect(normalizeSection({ sessionHeader: false }).sessionHeader).toBe(false)
    expect(normalizeSection({ sessionHeader: true }).sessionHeader).toBe(true)
    expect(normalizeSection({ sessionHeader: 'false' }).sessionHeader).toBe(true)
    expect(normalizeSection({ sessionHeader: 0 }).sessionHeader).toBe(true)
    expect(normalizeSection({}).sessionHeader).toBe(true)
  })

  it('keeps a defaultIdentity string and clears malformed ones', () => {
    expect(normalizeSection({ defaultIdentity: 'main' }).defaultIdentity).toBe('main')
    expect(normalizeSection({ defaultIdentity: 42 }).defaultIdentity).toBe('')
    // Not trimmed here either: findIdentity trims at resolution time.
    expect(normalizeSection({ defaultIdentity: ' main ' }).defaultIdentity).toBe(' main ')
  })
})

describe('identityFromUnknown', () => {
  it('coerces every non-string field to the empty string', () => {
    expect(identityFromUnknown({ id: 42, team: null, agent: [], task: {}, headers: 'nope' }))
      .toEqual({ id: '', team: '', agent: '', task: '', headers: [] })
  })

  it('keeps blank-name rows so validation can flag them', () => {
    // The editor strips fully blank rows before saving; coercion must not, or
    // a "value without a name" mistake would disappear without a finding.
    const coerced = identityFromUnknown({ id: '', headers: [{ name: '', value: 'orphan' }] })
    expect(coerced.headers).toEqual([{ name: '', value: 'orphan' }])
    expect(validateIdentities({ ...defaultSection(), identities: [coerced] }).map(issue => issue.code))
      .toEqual(['id-empty', 'team-empty', 'name-empty'])
  })

  it('answers an empty identity for a non-record value', () => {
    expect(identityFromUnknown('garbage')).toEqual({ id: '', team: '', agent: '', task: '', headers: [] })
    expect(identityFromUnknown(undefined)).toEqual({ id: '', team: '', agent: '', task: '', headers: [] })
  })
})

describe('validateIdentities', () => {
  it('accepts a usable list', () => {
    expect(validateIdentities(section({ identities: [identity(), identity({ id: 'Relay' })] }))).toEqual([])
  })

  it.each(['off', 'default', ' OFF ', ' Default '])('rejects reserved model-pick id %j', id => {
    expect(validateIdentities(section({ identities: [identity({ id })] })))
      .toEqual([{ identity: 0, code: 'id-duplicate', value: id.trim() }])
    expect(() => { assertValidSection(section({ identities: [identity({ id })] })) })
      .toThrow(`uses the reserved model-pick id "${id.trim()}"`)
  })

  it.each(['team', 'agent', 'task'] as const)('validates the %s header value without exposing it', field => {
    for (const value of ['secret\r\ninjected', 'secret\u0000', 'secret\u0100']) {
      expect(validateIdentities(section({ identities: [identity({ [field]: value })] })))
        .toEqual([{ identity: 0, code: 'value-invalid', value: field }])
      expect(() => { assertValidSection(section({ identities: [identity({ [field]: value })] })) })
        .toThrow(`has a value that cannot be sent as an HTTP header ("${field}")`)
    }
  })

  it('accepts optional empty triple values and Fetch-valid whitespace and Latin-1 values', () => {
    expect(validateIdentities(section({ identities: [identity({ team: ' téam\t', agent: '', task: '' })] }))).toEqual([])
  })

  it('flags an empty id', () => {
    expect(validateIdentities(section({ identities: [identity({ id: '  ' })] })))
      .toEqual([{ identity: 0, code: 'id-empty', value: '  ' }])
  })

  it('flags duplicate ids case-insensitively, keeping the first occurrence', () => {
    const issues = validateIdentities(section({
      identities: [identity({ id: 'Gateway' }), identity({ id: 'gateway' }), identity({ id: 'GATEWAY' })],
    }))
    expect(issues.map(issue => issue.code)).toEqual(['id-duplicate', 'id-duplicate'])
    expect(issues.map(issue => issue.identity)).toEqual([1, 2])
    expect(issues[0]?.value).toBe('gateway')
  })

  it('treats ids equal after trimming as the same identity', () => {
    expect(validateIdentities(section({
      identities: [identity({ id: 'a' }), identity({ id: ' a ' })],
    })).map(issue => issue.code)).toEqual(['id-duplicate'])
  })

  it('treats different spellings as distinct', () => {
    expect(validateIdentities(section({ identities: [identity({ id: 'a' }), identity({ id: 'ab' })] }))).toEqual([])
  })

  it('does not flag an empty id twice when it also has the same id value', () => {
    expect(validateIdentities(section({ identities: [identity({ id: '' }), identity({ id: '' })] })))
      .toEqual([
        { identity: 0, code: 'id-empty', value: '' },
        { identity: 1, code: 'id-empty', value: '' },
      ])
  })

  it('requires a team: the proxy can never inject memory for a teamless identity', () => {
    expect(validateIdentities(section({ identities: [identity({ team: '   ' })] })))
      .toEqual([{ identity: 0, code: 'team-empty', value: 'main' }])
  })

  it('flags a header value without a name but ignores a fully blank row', () => {
    const issues = validateIdentities(section({
      identities: [identity({ headers: [{ name: '', value: '' }, { name: '  ', value: 'v' }] })],
    }))
    expect(issues).toEqual([{ identity: 0, row: 1, code: 'name-empty', value: 'v' }])
  })

  it('never lets a configured row become the session header, even unvalidated', () => {
    // The composition base bypasses the settings write path, so identityHeaders
    // enforces the reservation itself: this is the last line before the wire.
    const headers = identityHeaders(
      identity({ team: 't', agent: 'a', task: '', headers: [
        { name: 'x-deepseek-harness-session-id', value: 'one-conversation' },
        { name: 'X-DeepSeek-Harness-Session-Id', value: 'other' },
        { name: 'X-Extra', value: 'kept' },
      ] }),
      { team: 'x-team-id', agent: 'x-agent-id', task: 'x-task-id' },
    )
    expect(headers).toEqual({ 'x-team-id': 't', 'x-agent-id': 'a', 'X-Extra': 'kept' })
  })

  it('refuses an extra row that claims the session header, in any casing', () => {
    // That header is the conversation key: a constant value from a configured
    // row would merge every session into one proxy conversation.
    for (const name of ['x-deepseek-harness-session-id', 'X-DeepSeek-Harness-Session-Id']) {
      const issues = validateIdentities(section({
        identities: [identity({ headers: [{ name, value: 'one-conversation' }] })],
      }))
      expect(issues).toEqual([{ identity: 0, row: 0, code: 'name-reserved', value: name }])
    }
  })

  it('refuses to let an identity field take a transport header', () => {
    // Measured: with headerNames.team = 'authorization' an attach overwrites the
    // caller's own Bearer token, and a detach deletes it outright.
    for (const name of ['authorization', 'Authorization', 'cookie', 'host', 'content-length', 'content-type']) {
      expect(() => assertValidSection(section({ headerNames: { team: name, agent: 'x-agent-id', task: 'x-task-id' } })))
        .toThrow(/must not be/)
    }
    // The default names stay accepted.
    expect(() => assertValidSection(section())).not.toThrow()
  })

  it('refuses an extra row that reuses a configured header name, in any casing', () => {
    // The row would silently replace the value the editor shows for that field,
    // and HTTP names are case-insensitive, so an exact-case check is not enough.
    for (const name of ['x-team-id', 'X-Team-Id', 'x-agent-id', 'X-Task-Id']) {
      const issues = validateIdentities(section({
        identities: [identity({ headers: [{ name, value: 'spoof' }] })],
      }))
      expect(issues).toEqual([{ identity: 0, row: 0, code: 'name-conflict', value: name }])
    }
  })

  it('refuses two rows on the same header name, in any casing', () => {
    // HTTP names are case-insensitive, so a second row either silently drops
    // the first value or puts two values on the wire for one header.
    for (const second of ['x-dup', 'X-Dup']) {
      const issues = validateIdentities(section({
        identities: [identity({ headers: [{ name: 'x-dup', value: 'one' }, { name: second, value: 'two' }] })],
      }))
      expect(issues).toEqual([{ identity: 0, row: 1, code: 'name-duplicate', value: second }])
    }
  })

  it('flags header names Fetch cannot represent', () => {
    const issues = validateIdentities(section({
      identities: [identity({ headers: [{ name: 'bad header', value: '' }] })],
    }))
    expect(issues).toEqual([{ identity: 0, row: 0, code: 'name-invalid', value: 'bad header' }])
  })

  it('flags header values Fetch cannot represent as value-invalid, echoing the name', () => {
    // A newline is a header-injection attempt the Fetch grammar refuses.
    const issues = validateIdentities(section({
      identities: [identity({ headers: [{ name: 'X-Test', value: 'a\nb' }] })],
    }))
    expect(issues).toEqual([{ identity: 0, row: 0, code: 'value-invalid', value: 'X-Test' }])
  })

  it('reports every issue in identity-then-row order', () => {
    const issues = validateIdentities(section({
      identities: [
        identity({ id: '', team: '', headers: [{ name: 'bad header', value: 'x' }, { name: 'X-Ok', value: 'a\nb' }] }),
        identity({ id: 'MAIN' }),
        identity({ id: 'main' }),
      ],
    }))
    expect(issues.map(issue => `${String(issue.code)}@${String(issue.identity)}${issue.row === undefined ? '' : `/${String(issue.row)}`}`))
      .toEqual(['id-empty@0', 'team-empty@0', 'name-invalid@0/0', 'value-invalid@0/1', 'id-duplicate@2'])
  })
})

describe('assertValidSection', () => {
  it.each(['team', 'agent', 'task'] as const)('rejects invalid configured %s header names', field => {
    for (const name of ['', 'bad header', ' x-team ', 'bad\nheader', '头']) {
      expect(() => { assertValidSection(section({ headerNames: { ...NAMES, [field]: name } })) })
        .toThrow(`headerNames.${field} must be a valid HTTP header name`)
    }
  })

  it.each([
    { ...NAMES, agent: 'X-TEAM-ID' },
    { ...NAMES, task: 'X-TEAM-ID' },
    { ...NAMES, task: 'X-AGENT-ID' },
  ])('rejects case-insensitive duplicate configured header names: %j', headerNames => {
    expect(() => { assertValidSection(section({ headerNames })) })
      .toThrow(/duplicates another configured header name \(names are case-insensitive\)/)
  })

  it.each(['team', 'agent', 'task'] as const)('reserves the session header against %s collisions even when disabled', field => {
    for (const sessionHeader of [true, false]) {
      expect(() => {
        assertValidSection(section({ headerNames: { ...NAMES, [field]: 'X-DeepSeek-Harness-Session-ID' }, sessionHeader }))
      }).toThrow(`headerNames.${field} collides with the reserved session header`)
    }
  })

  it('rejects a dangling nonempty default identity', () => {
    for (const identities of [[], [identity()]]) {
      expect(() => { assertValidSection(section({ identities, defaultIdentity: ' missing ' })) })
        .toThrow('defaultIdentity must name a configured identity')
    }
  })

  it('preserves empty defaults and resolves configured defaults case-insensitively', () => {
    expect(() => { assertValidSection(defaultSection()) }).not.toThrow()
    expect(() => { assertValidSection(section({ defaultIdentity: '  ' })) }).not.toThrow()
    expect(() => { assertValidSection(section({ identities: [identity()], defaultIdentity: ' MAIN ' })) }).not.toThrow()
  })

  it('throws a message naming the identity for an empty id', () => {
    expect(() => { assertValidSection(section({ identities: [identity({ id: '' })] })) })
      .toThrow(/^memory-gate: identity #1 needs an id$/)
  })

  it('throws a message naming the duplicate and the case-insensitivity rule', () => {
    expect(() => { assertValidSection(section({ identities: [identity({ id: 'a' }), identity({ id: 'A' })] })) })
      .toThrow(/^memory-gate: identity #2 duplicates the id "A" \(ids are case-insensitive\)$/)
  })

  it('explains why a team is mandatory', () => {
    expect(() => { assertValidSection(section({ identities: [identity({ team: '' })] })) })
      .toThrow(/identity #1 needs a team id: the proxy treats a teamless request as unidentified/)
  })

  it('names the header row for row-level findings', () => {
    expect(() => {
      assertValidSection(section({ identities: [identity({ headers: [{ name: 'X-A', value: '' }, { name: '', value: 'v' }] })] }))
    }).toThrow(/identity #1 header row #2 has a value but no header name/)
  })

  it('does not throw for a valid section', () => {
    expect(() => { assertValidSection(section({ identities: [identity()] })) }).not.toThrow()
  })
})

describe('findIdentity', () => {
  const identities = [identity({ id: ' Worker ' }), identity({ id: 'reviewer' })]

  it('resolves an id case-insensitively and despite surrounding whitespace', () => {
    expect(findIdentity(section({ identities }), 'worker')?.id).toBe(' Worker ')
    expect(findIdentity(section({ identities }), ' WORKER ')?.id).toBe(' Worker ')
    expect(findIdentity(section({ identities }), 'reviewer')?.id).toBe('reviewer')
  })

  it('answers undefined for an unknown, empty or absent id', () => {
    expect(findIdentity(section({ identities }), 'nope')).toBeUndefined()
    expect(findIdentity(section({ identities }), '   ')).toBeUndefined()
    expect(findIdentity(section({ identities }), undefined)).toBeUndefined()
    expect(findIdentity(section({ identities: [] }), 'worker')).toBeUndefined()
  })
})

describe('parsePick', () => {
  it('reads every non-string and blank value as "default"', () => {
    for (const raw of [undefined, null, 42, true, [], {}, '', '   ']) {
      expect(parsePick(raw)).toBe('default')
    }
  })

  it('recognizes "off" and "default" case-insensitively and trimmed', () => {
    expect(parsePick('off')).toBe('off')
    expect(parsePick(' OFF ')).toBe('off')
    expect(parsePick('default')).toBe('default')
    expect(parsePick('Default')).toBe('default')
  })

  it('reads anything else as a named identity, trimmed', () => {
    expect(parsePick('team-a')).toEqual({ identity: 'team-a' })
    expect(parsePick('  Team-A  ')).toEqual({ identity: 'Team-A' })
    // "offline" is an identity id, not the "off" sentinel.
    expect(parsePick('offline')).toEqual({ identity: 'offline' })
  })
})

describe('modelsOf / modelPickOf / providerBaseURL', () => {
  const providers = {
    magpie: {
      baseURL: 'http://127.0.0.1:8096/dsh/default',
      models: [
        { id: 'm1', memoryGate: 'team-a' },
        { id: 'm2', memoryGate: 'off' },
        { id: 'm3' },
        { id: 'm4', memoryGate: 42 },
        'junk',
      ],
    },
    bare: {},
    broken: { models: 'nope' },
  }

  it('lists only record model rows of one route', () => {
    expect(modelsOf(providers, 'magpie').map(model => model['id'])).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(modelsOf(providers, 'bare')).toEqual([])
    expect(modelsOf(providers, 'broken')).toEqual([])
    expect(modelsOf(providers, 'missing')).toEqual([])
    expect(modelsOf(undefined, 'magpie')).toEqual([])
    expect(modelsOf('garbage', 'magpie')).toEqual([])
  })

  it('reads one exact route/model pick', () => {
    expect(modelPickOf(providers, 'magpie', 'm1')).toEqual({ identity: 'team-a' })
    expect(modelPickOf(providers, 'magpie', 'm2')).toBe('off')
  })

  it('degrades a missing, unparsable or hostile pick to "default"', () => {
    expect(modelPickOf(providers, 'magpie', 'm3')).toBe('default')
    expect(modelPickOf(providers, 'magpie', 'm4')).toBe('default')
    expect(modelPickOf(providers, 'magpie', 'nope')).toBe('default')
    expect(modelPickOf(providers, 'nope', 'm1')).toBe('default')
    expect(modelPickOf(undefined, 'magpie', 'm1')).toBe('default')
  })

  it('reads a route base URL only when it is a non-empty string', () => {
    expect(providerBaseURL(providers, 'magpie')).toBe('http://127.0.0.1:8096/dsh/default')
    expect(providerBaseURL({ magpie: { baseURL: '  http://x/v1  ' } }, 'magpie')).toBe('http://x/v1')
    expect(providerBaseURL({ magpie: { baseURL: '' } }, 'magpie')).toBeUndefined()
    expect(providerBaseURL({ magpie: { baseURL: 42 } }, 'magpie')).toBeUndefined()
    expect(providerBaseURL(providers, 'bare')).toBeUndefined()
    expect(providerBaseURL(providers, 'nope')).toBeUndefined()
    expect(providerBaseURL(undefined, 'magpie')).toBeUndefined()
  })
})

describe('isMemoryChain', () => {
  it('defaults to only the loopback proxy, independently of request path', () => {
    expect(isMemoryChain('http://127.0.0.1:8096/dsh/default')).toBe(true)
    expect(isMemoryChain('http://127.0.0.1:8096')).toBe(true)
    expect(isMemoryChain('http://127.0.0.1:8096/memory?x=1#tag')).toBe(true)
  })

  it('accepts exact explicitly configured origins with normalized hostname and default port', () => {
    expect(isMemoryChain('https://MEMORY.example:443/v1', ['https://memory.example/'])).toBe(true)
    expect(isMemoryChain('http://localhost:8096/v1', ['http://localhost:8096'])).toBe(true)
    expect(isMemoryChain('https://memory.example:8443/v1', ['https://memory.example:8443'])).toBe(true)
  })

  it.each([
    'http://host:8096/v1', 'http://localhost:8096/v1', 'https://127.0.0.1:8096/v1',
    'http://127.0.0.1:8097/v1', 'http://127.0.0.1:80961/v1', 'http://127.0.0.1:18096/v1',
    'https://tdai.example.com/v1', 'https://memory.internal/v1',
    'https://evil.example/http://127.0.0.1:8096/v1', 'https://evil.example/?proxy=:8096/',
    'http://127.0.0.1.evil.example:8096/v1', 'http://127.0.0.1:8096@evil.example/v1',
    'http://user:secret@127.0.0.1:8096/v1', 'http://@127.0.0.1:8096/v1',
    'ftp://127.0.0.1:8096/v1', 'file:///memory', 'not a URL', 'http://',
    'http:127.0.0.1:8096', '//127.0.0.1:8096', '', undefined,
  ])('rejects untrusted, spoofed, credentialed or malformed request %j', baseURL => {
    expect(isMemoryChain(baseURL)).toBe(false)
  })

  it('denies every request for an explicit empty allowlist', () => {
    expect(isMemoryChain('http://127.0.0.1:8096/v1', [])).toBe(false)
  })

  it.each(['https://example.com/path', 'https://user@example.com', 'https://example.com/?q=1', 'https://example.com/#tag'])('does not derive trust from an invalid configured origin %j', origin => {
    expect(isMemoryChain('https://example.com/v1', [origin])).toBe(false)
  })
})

describe('identityHeaders', () => {
  it('skips empty parts of the identity triple', () => {
    expect(identityHeaders(identity({ team: '', agent: '', task: '' }), NAMES)).toEqual({})
    expect(identityHeaders(identity({ task: '  ' }), NAMES)).toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a' })
  })

  it('trims triple values and sends only the configured header names', () => {
    expect(identityHeaders(identity({ team: ' T ', agent: ' A ', task: ' K ' }), { team: 'X-Team', agent: 'X-Agent', task: 'X-Task' }))
      .toEqual({ 'X-Team': 'T', 'X-Agent': 'A', 'X-Task': 'K' })
  })

  it('appends extra rows verbatim without touching the identity triple', () => {
    const headers = identityHeaders(identity({
      headers: [{ name: 'X-Extra', value: ' spaced ' }],
    }), NAMES)
    expect(headers).toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a', 'X-Extra': ' spaced ' })
  })

  it('drops a row that reuses a configured header name instead of overwriting it', () => {
    // HTTP header names are case-insensitive: keeping both spellings would put
    // two values on the wire for one header. The identity's own field wins, and
    // validation reports `name-conflict` so the editor shows the problem.
    const headers = identityHeaders(identity({
      headers: [{ name: 'X-Team-Id', value: 'override' }],
    }), NAMES)
    expect(headers).toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
  })

  it('sends at most one value per header name across the configured triple', () => {
    // `assertValidSection` rejects case-duplicate names, but the composition
    // base only warns, so composition must not emit two values for one header.
    // team wins over agent over task, deterministically.
    const headers = identityHeaders(identity({ team: 'team-a', agent: 'agent-a', task: 'task-a' }),
      { team: 'X-Same', agent: 'x-same', task: 'x-task-id' })
    expect(headers).toEqual({ 'X-Same': 'team-a', 'x-task-id': 'task-a' })
  })

  it('never writes an identity value under the session header, whatever the switch', () => {
    // The composition base is only warned about at startup, so this is the one
    // path that can reach composition with a colliding configured name. With
    // the switch off a constant value there would become the conversation key
    // and merge every session into one proxy conversation.
    const colliding = { team: DSH_SESSION_HEADER, agent: 'x-agent-id', task: 'x-task-id' }
    const withSwitchOn = identityHeaders(identity({ team: 'team-a', agent: 'agent-a', task: 'task-a' }), colliding)
    expect(withSwitchOn).toEqual({ 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })

    const agentNameCollided = identityHeaders(identity({ team: 'team-a', agent: 'agent-a', task: 'task-a' }),
      { team: 'x-team-id', agent: DSH_SESSION_HEADER.toUpperCase(), task: 'x-task-id' })
    expect(agentNameCollided).toEqual({ 'x-team-id': 'team-a', 'x-task-id': 'task-a' })
  })

  it('keeps exactly one value when rows repeat a name, first spelling winning', () => {
    const headers = identityHeaders(identity({
      headers: [{ name: 'x-dup', value: 'one' }, { name: 'X-Dup', value: 'two' }],
    }), NAMES)
    expect(headers).toEqual({ 'x-dup': 'one', 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
  })

  it('ignores extra rows without a name', () => {
    expect(identityHeaders(identity({ headers: [{ name: '  ', value: 'v' }] }), NAMES))
      .toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
  })
})

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(1)).toBe(false)
  })
})