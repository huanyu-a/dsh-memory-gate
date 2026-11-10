/**
 * Pure identity logic: section defaults and coercion, write-time validation
 * (case-insensitive id uniqueness, Fetch-representable header names/values),
 * call-time header assembly, memory-chain recognition, the token estimator the
 * budget gate uses, and the model-row pick reader.
 *
 * Every function here is shared by the host and browser halves, so these tests
 * are the contract both halves rely on.
 */

import { describe, expect, it } from 'vitest'
import {
  defaultSection,
  estimateTokens,
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
  it('starts empty, teamless and detached from any budget', () => {
    expect(defaultSection()).toEqual({
      identities: [],
      defaultIdentity: '',
      headerNames: NAMES,
      budget: { enabled: false, maxRequestTokens: 120_000 },
      sessionHeader: true,
    })
  })

  it('hands out fresh objects, so one caller cannot mutate another’s defaults', () => {
    const first = defaultSection()
    first.identities.push(identity())
    first.headerNames.team = 'x-evil'
    first.budget.enabled = true
    expect(defaultSection().identities).toEqual([])
    expect(defaultSection().headerNames.team).toBe('x-team-id')
    expect(defaultSection().budget.enabled).toBe(false)
  })
})

describe('normalizeSection', () => {
  it('answers the defaults for a missing or non-record document', () => {
    expect(normalizeSection(undefined)).toEqual(defaultSection())
    expect(normalizeSection(null)).toEqual(defaultSection())
    expect(normalizeSection('garbage')).toEqual(defaultSection())
    expect(normalizeSection([])).toEqual(defaultSection())
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

  it('only enables the budget on a literal true and floors a positive limit', () => {
    expect(normalizeSection({ budget: { enabled: true, maxRequestTokens: 12.9 } }).budget)
      .toEqual({ enabled: true, maxRequestTokens: 12 })
    // Anything but `true` keeps the default (a string "true" is not a boolean).
    expect(normalizeSection({ budget: { enabled: 'true', maxRequestTokens: 12 } }).budget.enabled).toBe(false)
    expect(normalizeSection({ budget: { enabled: false } }).budget)
      .toEqual({ enabled: false, maxRequestTokens: 120_000 })
  })

  it('rejects non-positive, non-finite and non-numeric budget limits', () => {
    for (const maxRequestTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5000', null]) {
      expect(normalizeSection({ budget: { enabled: true, maxRequestTokens } }).budget.maxRequestTokens).toBe(120_000)
    }
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
  it('recognizes the TDAI proxy on its port, with or without a trailing path', () => {
    expect(isMemoryChain('http://127.0.0.1:8096/dsh/default')).toBe(true)
    expect(isMemoryChain('http://127.0.0.1:8096')).toBe(true)
    expect(isMemoryChain('HTTP://HOST:8096/V1')).toBe(true)
  })

  it('recognizes a host that names tdai or memory', () => {
    expect(isMemoryChain('https://tdai.example.com/v1')).toBe(true)
    expect(isMemoryChain('https://memory.internal/v1')).toBe(true)
  })

  it('does not match a direct public route', () => {
    expect(isMemoryChain('https://api.stepfun.com/v1')).toBe(false)
    expect(isMemoryChain('https://api.deepseek.com/v1')).toBe(false)
  })

  it('does not match a port that merely starts with 8096', () => {
    expect(isMemoryChain('http://127.0.0.1:80961/v1')).toBe(false)
    expect(isMemoryChain('http://127.0.0.1:18096/v1')).toBe(false)
  })

  it('does not match a path segment that happens to be named memory', () => {
    expect(isMemoryChain('https://example.com/memory/v1')).toBe(false)
  })

  it('answers false for an absent or empty base URL', () => {
    expect(isMemoryChain(undefined)).toBe(false)
    expect(isMemoryChain('')).toBe(false)
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

  it('appends extra rows verbatim, later names winning on an exact clash', () => {
    const headers = identityHeaders(identity({
      headers: [
        { name: 'X-Extra', value: ' spaced ' },
        { name: 'x-team-id', value: 'override' },
      ],
    }), NAMES)
    expect(headers).toEqual({ 'x-team-id': 'override', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a', 'X-Extra': ' spaced ' })
  })

  it('ignores extra rows without a name', () => {
    expect(identityHeaders(identity({ headers: [{ name: '  ', value: 'v' }] }), NAMES))
      .toEqual({ 'x-team-id': 'team-a', 'x-agent-id': 'agent-a', 'x-task-id': 'task-a' })
  })
})

describe('estimateTokens', () => {
  it('answers zero for no messages', () => {
    expect(estimateTokens([])).toBe(0)
  })

  it('counts latin text at roughly four characters per token plus per-message overhead', () => {
    expect(estimateTokens([{ role: 'user', content: 'abcd' }])).toBe(9)
    expect(estimateTokens([{ role: 'user', content: 'abcde' }])).toBe(10)
    expect(estimateTokens([{ role: 'user', content: '' }])).toBe(8)
  })

  it('counts CJK characters as denser than latin', () => {
    // 20 CJK characters ≈ 15 tokens; 20 latin characters = 5 tokens.
    expect(estimateTokens([{ content: '你好世界你好世界你好世界你好世界你好世界' }])).toBe(23)
    expect(estimateTokens([{ content: 'abcdefghijklmnopqrst' }])).toBe(13)
  })

  it('counts kana, hangul and fullwidth forms as CJK', () => {
    expect(estimateTokens([{ content: 'あいうえ' }])).toBe(3 + 8)
    expect(estimateTokens([{ content: '한국어' }])).toBe(3 + 8)
    expect(estimateTokens([{ content: 'ＡＢＣＤ' }])).toBe(3 + 8)
  })

  it('reads text blocks of array content and ignores non-text blocks', () => {
    expect(estimateTokens([{
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'image', source: { data: 'x'.repeat(1000) } },
        { type: 'text', text: 'efgh' },
      ],
    }])).toBe(2 + 8)
  })

  it('skips non-record messages but still counts their per-message overhead', () => {
    expect(estimateTokens([null, 'garbage', { content: 'abcd' }])).toBe(1 + 3 * 8)
  })

  it('ignores non-text content and non-string block text', () => {
    expect(estimateTokens([{ content: 42 }, { content: [{ text: 42 }] }])).toBe(2 * 8)
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