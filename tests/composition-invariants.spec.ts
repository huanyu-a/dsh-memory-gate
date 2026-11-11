// Property test for header composition. The four defects found in this family
// all had the same root: a JavaScript `Record` deduplicates by exact key while
// HTTP header names are case-insensitive. Rather than adding one example test
// per spelling, this asserts the invariant over a deterministic sweep of names
// that differ only by case, plus the session-header and reserved-name cases.
import { describe, expect, it } from 'vitest'
import { DSH_SESSION_HEADER } from '../src/constants.js'
import { identityHeaders, normalizeSection, validateIdentities, type HeaderNames } from '../src/identities.js'

const NAMES = ['x-team-id', 'X-Team-Id', 'x-agent-id', 'x-dup', 'X-Dup', 'x-extra', 'X-Extra',
  DSH_SESSION_HEADER, DSH_SESSION_HEADER.toUpperCase(), 'x-task-id']

/** Every combination of three names drawn from the pool. */
function* triples(): Generator<HeaderNames> {
  for (const team of NAMES) {
    for (const agent of NAMES) {
      for (const task of NAMES) yield { team, agent, task }
    }
  }
}

describe('header composition invariants', () => {
  it('never emits two values for one header name, however the names are cased', () => {
    const offenders: string[] = []
    for (const names of triples()) {
      const headers = identityHeaders(
        { id: 'a', team: 'TEAMVAL', agent: 'AGENTVAL', task: 'TASKVAL', headers: [] },
        names,
      )
      const lowered = Object.keys(headers).map(key => key.toLowerCase())
      if (new Set(lowered).size !== lowered.length) offenders.push(JSON.stringify(headers))
    }
    expect(offenders.slice(0, 5)).toEqual([])
  })

  it('never puts a constant identity value under the session header', () => {
    // That header is the conversation key: a constant there merges every
    // session into one proxy conversation.
    const constants = ['TEAMVAL', 'AGENTVAL', 'TASKVAL']
    const offenders: string[] = []
    for (const names of triples()) {
      const headers = identityHeaders(
        { id: 'a', team: 'TEAMVAL', agent: 'AGENTVAL', task: 'TASKVAL', headers: [] },
        names,
      )
      const value = headers[DSH_SESSION_HEADER]
      // identityHeaders never writes the session header; the gate adds it later.
      if (value !== undefined && constants.includes(value)) offenders.push(JSON.stringify(headers))
    }
    expect(offenders).toEqual([])
  })

  it('reports an issue for every rejected row, so the editor can explain it', () => {
    // A row the composition drops must never be dropped silently.
    const rows = [
      { name: DSH_SESSION_HEADER, value: 'v' },
      { name: 'X-Team-Id', value: 'v' },
      { name: 'x-dup', value: 'v' },
      { name: 'X-Dup', value: 'v' },
      { name: 'bad header', value: 'v' },
    ]
    const section = normalizeSection({
      identities: [{ id: 'a', team: 't', agent: 'a', task: '', headers: rows }],
      defaultIdentity: 'a',
    })
    const codes = validateIdentities(section).map(issue => issue.code)
    expect(codes).toEqual(['name-reserved', 'name-conflict', 'name-duplicate', 'name-invalid'])
  })
})
