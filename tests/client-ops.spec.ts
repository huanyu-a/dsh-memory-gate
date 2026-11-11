import { describe, expect, it, vi } from 'vitest'
import { fieldIssuesOf, writeModelPick } from '../src/client/ops.js'
import type { RemoteApi, SettingsJoin } from '../src/client/types.js'

function snapshot(revision = 1): SettingsJoin {
  return { writable: true, memoryGate: undefined, piAi: {
    ns: 'llm-pi-ai', revision, value: { providers: { route: { models: [
      { id: 'm1', memoryGate: 'worker', custom: { keep: true } },
      { id: 'm2', memoryGate: 'off' },
    ] } } },
  } as unknown as SettingsJoin['piAi'] }
}
function remote(mutate = vi.fn().mockResolvedValue({ ok: true })) {
  return { api: { settings: { mutate } } as unknown as RemoteApi, mutate }
}

describe('pre-save field checks', () => {
  const names = (team: string, agent: string, task: string) => ({ team, agent, task })
  const section = (headerNames: { team: string, agent: string, task: string }, ids = ['main']) => ({
    identities: ids.map(id => ({ id, team: id, agent: '', task: '', headers: [] })),
    defaultIdentity: 'main',
    headerNames,
    trustedOrigins: ['http://127.0.0.1:8096'],
    sessionHeader: true,
  })

  it('blocks the three names the host would reject: reserved, duplicate, unrepresentable', () => {
    // A reserved name is the conversation key; a duplicate makes two fields
    // fight; an unrepresentable name cannot be sent at all.
    expect(fieldIssuesOf(section(names('x-team-id', 'x-agent-id', 'x-deepseek-harness-session-id'))).headerName)
      .toBe('issueHeaderNameReserved')
    expect(fieldIssuesOf(section(names('X-Team-Id', 'x-team-id', 'x-task-id'))).headerName)
      .toBe('issueHeaderNameDuplicate')
    expect(fieldIssuesOf(section(names('x-team-id', 'bad name', 'x-task-id'))).headerName)
      .toBe('issueHeaderNameInvalid')
  })

  it('accepts three distinct representable names and flags only a dangling default', () => {
    expect(fieldIssuesOf(section(names('x-team-id', 'x-agent-id', 'x-task-id'))))
      .toEqual({ headerName: null, defaultMissing: false })
    expect(fieldIssuesOf(section(names('x-team-id', 'x-agent-id', 'x-task-id'), ['worker'])))
      .toEqual({ headerName: null, defaultMissing: true })
  })
})

describe('model picker settings writes', () => {
  it('removes only the selected pick for Default and preserves other fields/models', async () => {
    const { api, mutate } = remote()
    const original = snapshot()
    expect(await writeModelPick(api, 'route', 'm1', null, async () => original)).toEqual({ ok: true })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'route', 'models'], value: [
      { id: 'm1', custom: { keep: true } }, { id: 'm2', memoryGate: 'off' },
    ] }], 1)
    expect(JSON.stringify(original)).toContain('worker')
  })

  it('re-reads on a conflict and uses the fresh revision exactly once', async () => {
    const mutate = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'conflict' } }).mockResolvedValue({ ok: true })
    const { api } = remote(mutate)
    const read = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValue(snapshot(2))
    expect(await writeModelPick(api, 'route', 'm1', 'off', read)).toEqual({ ok: true })
    expect(read).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls.map(call => call[2])).toEqual([1, 2])
  })

  it('does not retry a non-conflict rejection', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: false, error: { code: 'settings/rejected', message: 'read only' } })
    const { api } = remote(mutate)
    expect(await writeModelPick(api, 'route', 'm1', 'off', async () => snapshot())).toEqual({ ok: false, error: 'read only' })
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it('refuses unsaved or malformed model rows rather than mutating another row', async () => {
    const { api, mutate } = remote()
    expect(await writeModelPick(api, 'route', 'missing', 'off', async () => snapshot())).toEqual({ ok: false, error: 'model-not-found' })
    const bad = snapshot()
    ;(bad.piAi!.value as { providers: { route: { models: unknown[] } } }).providers.route.models.push(null)
    expect(await writeModelPick(api, 'route', 'm1', 'off', async () => bad)).toEqual({ ok: false, error: 'invalid-models' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses a write when the latest namespace becomes read-only', async () => {
    const { api, mutate } = remote()
    expect(await writeModelPick(api, 'route', 'm1', 'off', async () => ({ ...snapshot(), writable: false }))).toEqual({ ok: false, error: 'read-only' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('converts read transport errors into a write refusal', async () => {
    const { api, mutate } = remote()
    expect(await writeModelPick(api, 'route', 'm1', 'off', async () => { throw new Error('offline') })).toEqual({ ok: false, error: 'offline' })
    expect(mutate).not.toHaveBeenCalled()
  })
})
