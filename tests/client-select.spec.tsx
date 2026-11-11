// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelGateSelect, type ModelGateSelectProps } from '../src/client/ModelGateSelect.js'
import type { WriteReply } from '../src/client/types.js'

let host: HTMLDivElement
let root: Root
let mounted: boolean
let props: ModelGateSelectProps
function deferred() {
  let resolve!: (reply: WriteReply) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<WriteReply>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function render(patch: Partial<ModelGateSelectProps> = {}) {
  props = { ...props, ...patch }
  await act(async () => { root.render(<StrictMode><ModelGateSelect {...props} /></StrictMode>) })
}
function select() { return host.querySelector('select')! }
async function change(value: string) {
  await act(async () => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  props = {
    route: 'route-a', modelId: 'model-a', identities: [{ id: 'Alice' }, { id: 'Bob' }],
    readOnly: false, index: 0, t: key => key, onPick: vi.fn().mockResolvedValue({ ok: true }),
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  if (mounted) await act(async () => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

describe('model identity picker behavior', () => {
  it.each([
    [undefined, ''], ['off', 'off'], [' OFF ', 'off'], [' alice ', 'Alice'], ['Bob', 'Bob'],
  ])('renders stored %s as canonical %s', async (value, expected) => {
    await render({ value })
    expect(select().value).toBe(expected)
    expect(select().getAttribute('aria-label')).toBe('modelPicker: model-a')
  })

  it('writes canonical named, off and null default choices without optimistic state', async () => {
    await render()
    await change('Alice')
    expect(props.onPick).toHaveBeenLastCalledWith('route-a', 'model-a', 'Alice')
    expect(select().value).toBe('')
    await render({ value: 'Alice' })
    await change('off')
    expect(props.onPick).toHaveBeenLastCalledWith('route-a', 'model-a', 'off')
    await render({ value: 'off' })
    await change('')
    expect(props.onPick).toHaveBeenLastCalledWith('route-a', 'model-a', null)
  })

  it.each([{ staged: true }, { readOnly: true }])('blocks writes for %j', async patch => {
    await render(patch)
    expect(select().disabled).toBe(true)
    await change('Alice')
    expect(props.onPick).not.toHaveBeenCalled()
    if (patch.staged) {
      expect(select().title).toBe('modelPickerSaveFirst')
      expect(host.querySelector('[role="status"]')?.id).toBe(select().getAttribute('aria-describedby'))
    }
  })

  it('keeps a missing identity visible and correctable', async () => {
    await render({ value: 'Deleted' })
    expect(select().selectedOptions[0].textContent).toBe('Deleted (?)')
    expect(select().disabled).toBe(false)
    await change('Bob')
    expect(props.onPick).toHaveBeenCalledWith('route-a', 'model-a', 'Bob')
  })

  it('disables pending writes and prevents duplicate changes before React commits', async () => {
    const write = deferred()
    await render({ onPick: vi.fn(() => write.promise) })
    await act(async () => {
      for (const value of ['Alice', 'Bob']) {
        select().value = value
        select().dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    expect(select().disabled).toBe(true)
    expect(props.onPick).toHaveBeenCalledTimes(1)
    await act(async () => { write.resolve({ ok: true }) })
    expect(select().disabled).toBe(false)
  })

  it.each(['reply', 'reject', 'throw', 'string'] as const)('surfaces %s failures and clears them on retry', async kind => {
    const onPick = vi.fn((): Promise<WriteReply> => {
      if (kind === 'throw') throw new Error('offline')
      if (kind === 'reject') return Promise.reject(new Error('offline'))
      if (kind === 'string') return Promise.reject('offline')
      return Promise.resolve({ ok: false, error: 'offline' })
    })
    await render({ onPick })
    await change('Alice')
    expect(select().disabled).toBe(false)
    expect(host.querySelector('[data-failed="true"]')).not.toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('modelPickerWriteFailed: offline')
    expect(select().title).toBe('modelPickerWriteFailed: offline')
    expect(select().getAttribute('aria-describedby')).toBe(host.querySelector('[role="status"]')?.id)
    onPick.mockResolvedValue({ ok: true })
    await change('Bob')
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(host.querySelector('[data-failed="true"]')).toBeNull()
  })

  it.each(['route', 'modelId'] as const)('isolates pending writes after changing %s', async field => {
    const old = deferred()
    const current = deferred()
    const onPick = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await render({ onPick })
    await change('Alice')
    await render({ [field]: 'new-target' })
    expect(select().disabled).toBe(false)
    await change('Bob')
    await act(async () => { old.resolve({ ok: false, error: 'stale error' }) })
    expect(host.textContent).not.toContain('stale error')
    expect(select().disabled).toBe(true)
    await act(async () => { current.resolve({ ok: true }) })
    expect(select().disabled).toBe(false)
  })

  it('clears a previous target error when the row is rerouted', async () => {
    await render({ onPick: vi.fn().mockResolvedValue({ ok: false, error: 'old error' }) })
    await change('Alice')
    await render({ route: 'new-route' })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores %s completion after unmount', async outcome => {
    const write = deferred()
    await render({ onPick: vi.fn(() => write.promise) })
    await change('Alice')
    await act(async () => { root.unmount() })
    mounted = false
    await act(async () => {
      if (outcome === 'reject') write.reject(new Error('stale rejection'))
      else write.resolve({ ok: false, error: 'stale failure' })
    })
    expect(host.textContent).toBe('')
    expect(console.error).not.toHaveBeenCalled()
  })
})
