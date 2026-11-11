// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSection } from '../src/identities.js'
import type { RemoteApi } from '../src/client/types.js'
import type { CardTranslate } from '../src/client/locales.js'

const mocks = vi.hoisted(() => ({ describe: vi.fn(), write: vi.fn() }))
vi.mock('../src/client/ops.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/ops.js')>(),
  describeNamespaces: mocks.describe,
  writeSection: mocks.write,
}))
import { MemoryGateCard } from '../src/client/MemoryGateCard.js'

const api = {} as RemoteApi
const t: CardTranslate = key => key
let host: HTMLDivElement
let root: Root
let invalidate: () => void
let unsubscribe: () => void
function join(sessionHeader = true, revision = 1) {
  return { writable: true, memoryGate: { ns: 'memory-gate', revision, value: { ...defaultSection(), sessionHeader } } }
}
async function render() {
  await act(async () => {
    root.render(<MemoryGateCard api={api} t={t} subscribe={listener => { invalidate = listener; return () => { unsubscribe() } }} />)
  })
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(el => el.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function sessionToggle() {
  const found = [...host.querySelectorAll('label')].find(el => el.textContent?.includes('sessionHeader'))?.querySelector('input')
  if (!found) throw new Error('Missing session toggle')
  return found
}
async function click(element: HTMLElement) { await act(async () => { element.click() }) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.describe.mockReset().mockResolvedValue(join())
  mocks.write.mockReset().mockResolvedValue({ ok: true })
  unsubscribe = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

describe('memory gate card interactions', () => {
  it.each([
    ['http://127.0.0.1:8096\nhttps://memory.example:9443', ['http://127.0.0.1:8096', 'https://memory.example:9443']],
    ['', []],
    ['not an origin\nhttps://example.com/path', ['not an origin', 'https://example.com/path']],
  ])('retains edited trusted origins through save: %s', async (text, origins) => {
    await render()
    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toBe('http://127.0.0.1:8096')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe(text)
    expect(button('save').disabled).toBe(false)
    // Simulate the host acknowledging precisely the edited section.
    mocks.write.mockImplementationOnce(async (_api, section) => {
      mocks.describe.mockResolvedValue({
        ...join(true, 2),
        memoryGate: { ...join(true, 2).memoryGate, value: section },
      })
      return { ok: true }
    })
    await click(button('save'))
    expect(mocks.write).toHaveBeenCalledWith(api, expect.objectContaining({ trustedOrigins: origins }), undefined, 1)
    expect(textarea.value).toBe(text)
    expect(button('save').disabled).toBe(true)
  })

  it('follows external updates after a draft is reverted to its baseline', async () => {
    await render()
    await click(sessionToggle())
    expect(button('save').disabled).toBe(false)
    await click(sessionToggle())
    expect(button('save').disabled).toBe(true)
    mocks.describe.mockResolvedValue(join(false, 2))
    await act(async () => { invalidate() })
    expect(sessionToggle().checked).toBe(false)
  })

  it('keeps a dirty draft and its revision across external invalidations', async () => {
    await render()
    await click(sessionToggle())
    mocks.describe.mockResolvedValue(join(true, 9))
    await act(async () => { invalidate() })
    expect(sessionToggle().checked).toBe(false)
    await click(button('save'))
    expect(mocks.write).toHaveBeenCalledWith(api, expect.objectContaining({ sessionHeader: false }), undefined, 1)
  })

  it('renders a retry action after an initial transport failure', async () => {
    mocks.describe.mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    const retry = [...host.querySelectorAll('button')].find(el => !el.disabled)
    expect(retry).toBeDefined()
    await click(retry!)
    expect(sessionToggle().checked).toBe(true)
  })

  it('shows a retryable error when the namespace is unavailable', async () => {
    mocks.describe.mockResolvedValueOnce({ writable: false, memoryGate: undefined })
    await render()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect([...host.querySelectorAll('button')].some(el => !el.disabled)).toBe(true)
  })

  it('does not lose the committed values if post-save refresh fails', async () => {
    await render()
    await click(sessionToggle())
    mocks.describe.mockRejectedValue(new Error('refresh offline'))
    await click(button('save'))
    expect(sessionToggle().checked).toBe(false)
    expect(button('save').disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('recovers the confirmed revision through retry before permitting another edit', async () => {
    await render()
    await click(sessionToggle())
    mocks.describe.mockRejectedValue(new Error('offline'))
    await click(button('save'))
    expect(sessionToggle().disabled).toBe(true)
    expect(host.textContent).not.toContain('unsaved')
    mocks.describe.mockResolvedValue(join(false, 3))
    await click(button('retry'))
    expect(sessionToggle().disabled).toBe(false)
    await click(sessionToggle())
    await click(button('save'))
    expect(mocks.write).toHaveBeenLastCalledWith(api, expect.objectContaining({ sessionHeader: true }), undefined, 3)
  })

  it('preserves a dirty draft through a subscription read failure and retry', async () => {
    await render()
    await click(sessionToggle())
    mocks.describe.mockRejectedValueOnce(new Error('reconnect failed'))
    await act(async () => { invalidate() })
    expect(sessionToggle().checked).toBe(false)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    mocks.describe.mockResolvedValue(join(true, 8))
    await click(button('retry'))
    expect(sessionToggle().checked).toBe(false)
    await click(button('save'))
    expect(mocks.write).toHaveBeenCalledWith(api, expect.anything(), undefined, 1)
  })

  it('retains a draft and exposes a rejected save', async () => {
    await render()
    await click(sessionToggle())
    mocks.write.mockResolvedValue({ ok: false, error: 'settings/conflict' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await click(button('save'))
    expect(sessionToggle().checked).toBe(false)
    expect(host.textContent).toContain('settings/conflict')
    expect(button('save').disabled).toBe(false)
  })

  it('catches a thrown write instead of leaving the editor saving forever', async () => {
    await render()
    await click(sessionToggle())
    mocks.write.mockRejectedValue(new Error('write offline'))
    await click(button('save'))
    expect(button('save').disabled).toBe(false)
    expect(host.textContent).toContain('write offline')
  })

  it('discards the draft and fetches the latest baseline', async () => {
    await render()
    await click(sessionToggle())
    mocks.describe.mockResolvedValue(join(false, 7))
    await click(button('discard'))
    expect(sessionToggle().checked).toBe(false)
    expect(button('save').disabled).toBe(true)
    expect(host.textContent).not.toContain('unsaved')
  })

  it('ignores an invalidation read that started before the write was acknowledged', async () => {
    await render()
    await click(sessionToggle())
    let resolveWrite!: (reply: { ok: true }) => void
    let resolveOld!: (value: ReturnType<typeof join>) => void
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve }))
    await click(button('save'))
    mocks.describe.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    await act(async () => { invalidate() })
    mocks.describe.mockResolvedValue(join(false, 4))
    await act(async () => { resolveWrite({ ok: true }) })
    await act(async () => { resolveOld(join(true, 1)) })
    expect(sessionToggle().checked).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it('keeps controls disabled for a read-only namespace', async () => {
    mocks.describe.mockResolvedValue({ ...join(), writable: false })
    await render()
    expect(sessionToggle().disabled).toBe(true)
    expect(button('save').disabled).toBe(true)
  })

  it('ignores a stale read that resolves after a newer invalidation', async () => {
    let resolveOld!: (value: ReturnType<typeof join>) => void
    mocks.describe.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    await render()
    mocks.describe.mockResolvedValue(join(false, 2))
    await act(async () => { invalidate() })
    expect(sessionToggle().checked).toBe(false)
    await act(async () => { resolveOld(join(true, 1)) })
    expect(sessionToggle().checked).toBe(false)
  })

  it('disposes its invalidation subscription on unmount', async () => {
    await render()
    await act(async () => { root.unmount() })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
