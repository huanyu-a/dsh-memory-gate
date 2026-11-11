// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createScanState, invalidateScanState, reconcile, routeOfCard,
  type HostLabels, type InjectorDeps, type ScanState, type SelectMountProps,
} from '../src/client/injector.js'
import type { SettingsJoin } from '../src/client/types.js'

const pluginId = 'memory-gate-test'
const english: HostLabels = {
  capacity: ['Model options', 'Capacities'], modelId: ['Model ID'], routeId: ['Provider ID'],
}
const providers = {
  alpha: { displayName: 'Alpha provider', models: [
    { id: 'm1', memoryGate: 'identity-a' }, { id: 'm2', memoryGate: 'off' }, { id: 'm3' },
  ] },
  beta: { displayName: 'Beta provider', models: [{ id: 'm1', memoryGate: 'off' }] },
}
function join(): SettingsJoin {
  // Only the resolved namespace values are consumed by the injector.
  return {
    piAi: { ns: 'pi-ai', revision: 1, value: { providers } },
    memoryGate: { ns: 'memory-gate', revision: 1, value: { identities: [
      { id: ' identity-a ' }, null, { id: '' }, { id: 12 }, { id: 'identity-b' },
    ] } },
    writable: true,
  } as unknown as SettingsJoin
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: HTMLElement
let state: ScanState
let snapshot: SettingsJoin
let labels: HostLabels
let deps: InjectorDeps
let editors: Array<{ unmount: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> }>
function card(html = '<span class="editorRoute">alpha</span>') {
  const element = document.createElement('section')
  element.className = 'host_editor_card'
  element.innerHTML = html
  root.append(element)
  return element
}
function row(parent: HTMLElement, id = 'm1', aria = 'Model options 1', modelLabel = 'Model ID 1') {
  const element = document.createElement('div')
  element.className = 'host_modelEntry_row'
  element.innerHTML = `<input aria-label="${modelLabel}"><button aria-label="${aria}"></button><div class="host_modelAdvanced_fields"></div>`
  element.querySelector('input')!.value = id
  parent.append(element)
  return { element, input: element.querySelector('input')!, container: element.lastElementChild as HTMLElement }
}
async function scan() {
  reconcile(root, deps, state, pluginId)
  await Promise.resolve()
}
function props(container: HTMLElement): SelectMountProps {
  const entry = state.mounted.get(container)
  if (!entry) throw new Error('Expected a mounted picker')
  return entry.props
}
beforeEach(() => {
  root = document.createElement('main')
  document.body.append(root)
  state = createScanState()
  snapshot = join()
  labels = english
  editors = []
  deps = {
    describeNamespace: vi.fn(async () => snapshot), labels: () => labels, t: key => key,
    mount: vi.fn((container, _props) => {
      const marker = document.createElement('div')
      marker.dataset.plugin = pluginId
      container.append(marker)
      const editor = { unmount: vi.fn(() => marker.remove()), render: vi.fn() }
      editors.push(editor)
      return editor
    }),
  }
})
afterEach(() => {
  for (const entry of state.mounted.values()) entry.editor.unmount()
  root.remove()
  vi.restoreAllMocks()
})

describe('routeOfCard discovery', () => {
  it('prioritizes an exact saved route over a conflicting title or create input', () => {
    const target = card('<span class="editorRoute"> alpha </span><span class="editorTitle">Beta provider</span><input aria-label="Provider ID 1" value="new-route">')
    expect(routeOfCard(target, providers, labels)).toEqual({ route: 'alpha', staged: false })
  })

  it.each([
    ['<span class="editorTitle"> Alpha provider </span>', 'alpha'],
    ['<span class="rowName">beta</span>', 'beta'],
    ['<span class="editorRoute">unknown</span><span class="editorTitle">Beta provider</span>', 'beta'],
  ])('resolves display names and title-only route keys: %s', (html, route) => {
    expect(routeOfCard(card(html), providers, labels)).toEqual({ route, staged: false })
  })

  it('accepts a trimmed localized create-route select', () => {
    labels = { ...english, routeId: ['提供商 ID', 'Provider ID'] }
    expect(routeOfCard(card('<select aria-label="提供商 ID 2"><option> fresh </option></select>'), providers, labels))
      .toEqual({ route: 'fresh', staged: true })
  })

  it.each(['', '  ', 'alpha'])('rejects blank or already-saved create routes without falling back to title: %j', value => {
    expect(routeOfCard(card(`<input aria-label="Provider ID 1" value="${value}"><span class="editorTitle">Beta provider</span>`), providers, labels)).toBeUndefined()
  })

  it.each(['<span class="editorTitle">missing</span>', '<span class="editorTitle">constructor</span>', '<span class="editorRoute">toString</span>', ''])('does not resolve unknown or inherited provider keys: %s', html => {
    expect(routeOfCard(card(html), providers, labels)).toBeUndefined()
  })
})

describe('reconcile discovery and mount lifecycle', () => {
  it('initializes isolated empty scan states and invalidates without disposing mounts', async () => {
    const target = row(card())
    await scan()
    const other = createScanState()
    expect(other).toEqual({ mounted: new Map(), describePromise: undefined, generation: 0 })
    expect(other.mounted).not.toBe(state.mounted)
    invalidateScanState(state)
    expect(state.generation).toBe(1)
    expect(state.describePromise).toBeUndefined()
    expect(state.mounted.has(target.container)).toBe(true)
    expect(editors[0]!.unmount).not.toHaveBeenCalled()
  })

  it('avoids wire reads for disconnected roots and absent/mismatched disclosure anchors', async () => {
    row(card(), 'm1', 'Unrelated options')
    await scan()
    expect(deps.describeNamespace).not.toHaveBeenCalled()
    root.remove()
    labels = { ...english, capacity: ['Unrelated options'] }
    await scan()
    expect(deps.describeNamespace).not.toHaveBeenCalled()
  })

  it('discovers localized and legacy row anchors, trims model ids, and reads picks per row', async () => {
    labels = { capacity: ['模型选项', 'Model options', 'Capacities'], modelId: ['模型 ID', 'Model ID'], routeId: english.routeId }
    const parent = card()
    const first = row(parent, ' m1 ', '模型选项 1', '模型 ID 1')
    const second = row(parent, 'm2', 'Capacities 2')
    const third = row(parent, 'm3', 'Model options 3')
    await scan()
    expect(props(first.container)).toMatchObject({ route: 'alpha', modelId: 'm1', value: 'identity-a', index: 0, staged: false, readOnly: false, identities: [{ id: 'identity-a' }, { id: 'identity-b' }] })
    // Discovery order follows label priority before DOM order.
    expect(props(second.container)).toMatchObject({ modelId: 'm2', value: 'off', index: 2 })
    expect(props(third.container).value).toBeUndefined()
    expect(deps.mount).toHaveBeenCalledTimes(3)
  })

  it('skips missing row/card/disclosure/model and route mismatches', async () => {
    root.innerHTML = '<button aria-label="Model options 1"></button>'
    const orphan = row(root)
    const parent = card()
    const collapsed = row(parent)
    collapsed.container.remove()
    row(parent, ' ')
    row(parent, 'm1', 'Model options 1', 'Wrong ID')
    row(card('<span class="editorRoute">missing</span>'))
    await scan()
    expect(state.mounted.size).toBe(0)
    expect(orphan.container.children.length).toBe(0)
  })

  it('deduplicates overlapping label prefixes and folds reads and unchanged renders', async () => {
    labels = { ...english, capacity: ['Model', 'Model options'] }
    row(card())
    await scan()
    await scan()
    expect(deps.describeNamespace).toHaveBeenCalledTimes(1)
    expect(deps.mount).toHaveBeenCalledTimes(1)
    expect(editors[0]!.render).not.toHaveBeenCalled()
  })

  it('does not claim an existing foreign mount with the same plugin marker', async () => {
    const target = row(card())
    target.container.innerHTML = `<div data-plugin="${pluginId}"></div>`
    await scan()
    expect(deps.mount).not.toHaveBeenCalled()
    expect(state.mounted.size).toBe(0)
  })

  it('remounts after its marker is externally removed', async () => {
    const target = row(card())
    await scan()
    target.container.replaceChildren()
    await scan()
    expect(editors[0]!.unmount).toHaveBeenCalledTimes(1)
    expect(deps.mount).toHaveBeenCalledTimes(2)
  })

  it('unmounts collapsed and deleted rows, then mounts a reopened disclosure', async () => {
    const parent = card()
    const first = row(parent)
    const second = row(parent, 'm2')
    await scan()
    first.container.remove()
    await scan()
    expect(editors[0]!.unmount).toHaveBeenCalledTimes(1)
    expect(state.mounted.has(second.container)).toBe(true)
    first.element.append(first.container)
    await scan()
    expect(deps.mount).toHaveBeenCalledTimes(3)
    parent.remove()
    await scan()
    expect(state.mounted.size).toBe(0)
    expect(editors[1]!.unmount).toHaveBeenCalledTimes(1)
    expect(editors[2]!.unmount).toHaveBeenCalledTimes(1)
  })

  it('updates saved values, identities, and writability in place after invalidation', async () => {
    const target = row(card())
    await scan()
    snapshot = { ...join(), writable: false, memoryGate: undefined, piAi: { ...snapshot.piAi!, value: { providers: { alpha: { models: [{ id: 'm1', memoryGate: 'off' }] } } } } }
    invalidateScanState(state)
    await scan()
    expect(deps.mount).toHaveBeenCalledTimes(1)
    expect(editors[0]!.render).toHaveBeenCalledWith(expect.objectContaining({ value: 'off', identities: [], readOnly: true }))
    expect(props(target.container).readOnly).toBe(true)
  })

  it('stages unsaved models and keeps an edited saved row from targeting another saved model', async () => {
    const parent = card()
    const saved = row(parent)
    const unsaved = row(parent, 'new-model')
    await scan()
    expect(props(unsaved.container).staged).toBe(true)
    expect(props(unsaved.container).value).toBeUndefined()
    saved.input.value = 'm2'
    await scan()
    expect(props(saved.container)).toMatchObject({ modelId: 'm2', staged: true })
    expect(props(saved.container).value).toBeUndefined()
    saved.input.value = 'm1'
    await scan()
    expect(props(saved.container)).toMatchObject({ staged: false, value: 'identity-a' })
  })

  it('adopts a staged row once the same model appears in refreshed settings', async () => {
    const target = row(card(), 'new-model')
    await scan()
    snapshot = { ...join(), piAi: { ...snapshot.piAi!, value: { providers: { alpha: { models: [{ id: 'new-model', memoryGate: 'off' }] } } } } }
    invalidateScanState(state)
    await scan()
    expect(props(target.container)).toMatchObject({ staged: false, value: 'off' })
  })

  it('stages new provider rows and resets saved identity when switching saved routes', async () => {
    const create = row(card('<input aria-label="Provider ID 1" value="fresh">'))
    const parent = card()
    const saved = row(parent)
    await scan()
    expect(props(create.container)).toMatchObject({ route: 'fresh', staged: true })
    parent.querySelector('span')!.textContent = 'beta'
    await scan()
    expect(props(saved.container)).toMatchObject({ route: 'beta', staged: false, value: 'off' })
  })

  it('folds concurrent reads and retries after a rejected describe', async () => {
    row(card())
    const pending = deferred<SettingsJoin>()
    vi.mocked(deps.describeNamespace).mockReturnValueOnce(pending.promise)
    reconcile(root, deps, state, pluginId)
    reconcile(root, deps, state, pluginId)
    expect(deps.describeNamespace).toHaveBeenCalledTimes(1)
    pending.reject(new Error('offline'))
    await Promise.resolve()
    expect(state.describePromise).toBeUndefined()
    await scan()
    expect(deps.describeNamespace).toHaveBeenCalledTimes(2)
    expect(deps.mount).toHaveBeenCalledTimes(1)
  })

  it('ignores stale generations without clearing the newer pending read', async () => {
    row(card())
    const stale = deferred<SettingsJoin>()
    const fresh = deferred<SettingsJoin>()
    vi.mocked(deps.describeNamespace).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    reconcile(root, deps, state, pluginId)
    invalidateScanState(state)
    reconcile(root, deps, state, pluginId)
    stale.reject(new Error('old request'))
    await Promise.resolve()
    expect(state.describePromise).toBe(fresh.promise)
    fresh.resolve(snapshot)
    await Promise.resolve()
    expect(deps.mount).toHaveBeenCalledTimes(1)
  })

  it('warns once when rows are on screen but no control matches, and stays quiet otherwise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A row whose disclosure button carries an unknown label: the shape a host
    // DOM change would produce. Without the diagnostic the picker just vanishes.
    const parent = card()
    row(parent, 'm1', 'Something else entirely')
    await scan()
    await scan()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('model row(s) are on screen')

    // A page with no model rows at all is normal: never warn about it.
    warn.mockClear()
    const quiet = createScanState()
    const emptyRoot = document.createElement('main')
    document.body.append(emptyRoot)
    reconcile(emptyRoot, deps, quiet, pluginId)
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not warn for a folded row that merely has no disclosure yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parent = card()
    const { element } = row(parent)
    // Collapsed: the disclosure container is gone, which is legitimate.
    element.lastElementChild!.remove()
    await scan()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('disposes a previously mounted picker when its route anchor stops resolving', async () => {
    const parent = card()
    row(parent)
    await scan()
    parent.querySelector('span')!.textContent = 'missing'
    await scan()
    expect(editors[0]!.unmount).toHaveBeenCalledTimes(1)
    expect(state.mounted.size).toBe(0)
  })

  it('does not mount a stale successful read or a read completed after detachment', async () => {
    row(card())
    const stale = deferred<SettingsJoin>()
    vi.mocked(deps.describeNamespace).mockReturnValueOnce(stale.promise)
    reconcile(root, deps, state, pluginId)
    invalidateScanState(state)
    stale.resolve(snapshot)
    await Promise.resolve()
    expect(deps.mount).not.toHaveBeenCalled()
    const detached = deferred<SettingsJoin>()
    vi.mocked(deps.describeNamespace).mockReturnValueOnce(detached.promise)
    reconcile(root, deps, state, pluginId)
    root.remove()
    detached.resolve(snapshot)
    await Promise.resolve()
    expect(deps.mount).not.toHaveBeenCalled()
  })
})
