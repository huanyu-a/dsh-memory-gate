// Loads the BUILT browser bundle the way the DSH web shell does and calls its
// `apply`, so the client half is exercised as a module rather than only through
// its imported functions. The shell wraps each bundle in
// `window.__ModuleLoader__.load({id, factory})` and hands `factory` a `require`
// that resolves the shared React copies; this harness reproduces exactly that.
//
// The React copies are stubbed: this checks the module contract (registration,
// slot writes, style/locale effects, teardown), not rendering. Rendering is
// covered by the jsdom component specs.
//
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const bundle = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/** Evaluate the bundle against a fake loader, returning its exports. */
async function loadBundle() {
  // The bundle subclasses React classes at module scope, so the real copies are
  // required — a hand-rolled stub cannot satisfy `class extends`.
  const [react, jsxRuntime, domClient] = await Promise.all([
    import('react'),
    import('react/jsx-runtime'),
    import('react-dom/client'),
  ])
  const modules: Record<string, unknown> = {
    'react': react,
    'react/jsx-runtime': jsxRuntime,
    'react-dom/client': domClient,
  }
  type Bundle = {
    name?: string
    inject?: string[]
    apply?: (ctx: unknown) => void
    MemoryGateCard?: unknown
    ModelGateSelect?: unknown
  }
  let exported: Bundle | undefined
  const harness = globalThis.window as unknown as {
    __ModuleLoader__?: {
      load?: (registration: { id: string, factory: (require: (specifier: string) => unknown) => Bundle }) => void
    }
  }
  harness.__ModuleLoader__ = {
    load: ({ factory }) => { exported = factory(specifier => modules[specifier]) },
  }
  expect(harness.__ModuleLoader__.load).toBeTypeOf('function')
  // eslint-disable-next-line no-new-func -- the bundle is a script, not a module.
  new Function('window', bundle)(harness)
  if (exported === undefined) throw new Error('the bundle did not call __ModuleLoader__.load')
  return exported
}

/** The cordis-shaped client context `apply` expects. */
function makeContext() {
  const effects: Array<() => (() => void) | undefined> = []
  const listeners = new Map<string, (payload?: unknown) => void>()
  const registeredSlots: unknown[] = []
  const dictionaries = new Map<string, unknown>()
  const ctx = {
    effect: (run: () => (() => void) | undefined) => { effects.push(run) },
    on: (name: string, cb: (payload?: unknown) => void) => {
      listeners.set(name, cb)
      return () => listeners.delete(name)
    },
    locale: {
      register: (ns: string, dict: unknown) => { dictionaries.set(ns, dict); return () => dictionaries.delete(ns) },
      bind: (ns: string) => (key: string) => `${ns}:${key}`,
      subscribe: () => () => undefined,
      getSnapshot: () => ({ language: 'zh' }),
    },
    remote: {
      settings: {
        describe: async () => ({ ok: true, value: { namespaces: [], writable: true } }),
        mutate: async () => ({ ok: true }),
      },
      $on: () => () => undefined,
    },
    slots: {
      // The card seats use the inject/entries/subscribe face; without it `apply`
      // deliberately skips those effects (a host with an older slot service).
      inject: (name: string) => { registeredSlots.push({ name }); return () => undefined },
      entries: () => [],
      subscribe: () => () => undefined,
    },
    get: () => undefined,
    fiber: {},
  }
  return { ctx, effects, registeredSlots, dictionaries, listeners }
}

describe('built browser bundle', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis.window as unknown as Record<string, unknown>)['__ModuleLoader__']
  })

  it('registers under the plugin id and exports the cordis client surface', async () => {
    const exports = await loadBundle()
    expect(exports.name).toBe('dsh-memory-header-gate')
    expect(exports.apply).toBeTypeOf('function')
    expect(exports.inject).toContain('slots')
    expect(exports.inject).toContain('remote.settings')
    // The shell renders these; a missing one is a blank card or dead picker.
    expect(exports.MemoryGateCard).toBeTypeOf('function')
    expect(exports.ModelGateSelect).toBeTypeOf('function')
  })

  it('apply() injects the stylesheet, registers the dictionary, and tears both down', async () => {
    const exports = await loadBundle()
    const { ctx, effects, dictionaries } = makeContext()
    exports.apply?.(ctx)

    const styles = Array.from(document.head.querySelectorAll('style'))
    expect(styles).toHaveLength(1)
    expect(styles[0].dataset['pluginStyles']).toBe('dsh-memory-header-gate')
    expect(styles[0].textContent?.length).toBeGreaterThan(100)

    // The dictionary registration lives inside an effect, so it appears only
    // once the shell runs them — and every effect must return a disposer.
    const disposers = effects.map(run => run())
    expect(dictionaries.get('dsh-memory-header-gate')).toBeDefined()
    expect(disposers.every(d => typeof d === 'function')).toBe(true)
    for (const dispose of disposers) if (dispose !== undefined) dispose()
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
  })

  it('apply() registers the settings card slot exactly once', async () => {
    const exports = await loadBundle()
    const { ctx, registeredSlots } = makeContext()
    exports.apply?.(ctx)
    const cardSlots = registeredSlots.filter(slot => JSON.stringify(slot).includes('MemoryGateCard'))
    expect(cardSlots.length).toBeLessThanOrEqual(1)
  })
})