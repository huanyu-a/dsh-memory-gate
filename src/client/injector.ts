/**
 * The DOM bypass injector: the piece that puts a memory-identity picker
 * *inside* the official Models page's model rows (the provider card's
 * model catalog, 模型目录).
 *
 * The official Models-page slot contract's sanctioned seats are coarser than
 * a model row, so this plugin mounts its picker as a DOM contribution inside
 * each model row's own disclosure — "Model options" (模型选项) since DSH
 * 0.1.7, "Capacities" (容量) on 0.1.5 — folded away together with the
 * official capacity fields while the row is collapsed, and rendered on the
 * row below "上下文窗口" / "最大输出" (grid-column 1/-1) with its own
 * "记忆身份" label when expanded. Rows are found through the official per-row
 * disclosure button, matched by aria-label prefix in the host's ACTIVE
 * language (the labels are resolved through the host's own `settings.models`
 * dictionary per scan, so a language switch or a late language pack relabels
 * the page and the anchors together).
 *
 * Because this walks the official page's rendered DOM (structure the harness
 * can change), the injector is defensive by construction:
 *   - it re-scans on every DOM mutation, and every scan reconciles
 *     idempotently;
 *   - a model row that carries no disclosure yet is left alone and picked up
 *     on the next mutation;
 *   - if the official structure it depends on ever stops appearing, it simply
 *     stops injecting — the settings page remains untouched.
 *
 * @module dsh-memory-gate/client/injector
 */

import { MEMORY_GATE_FIELD } from '../constants.js'
import { isRecord, modelPickOf, modelsOf } from '../identities.js'
import { providersOf } from './ops.js'
import type { SettingsJoin } from './types.js'

export type { SettingsJoin }

/**
 * Localized aria-labels of the official settings controls this injector
 * anchors to, in the language the host is currently rendering. Every field
 * is a LIST because the official labels are numbered per row ("Model ID 1",
 * "Model ID 2", …) and are matched by prefix; each list carries the active
 * language first and English last — the host's own fallback floor.
 */
export interface HostLabels {
  /** The per-row disclosure button ("Model options"/模型选项 on 0.1.7+, "Capacities"/容量 on 0.1.5). */
  capacity: readonly string[]
  /** The model-id input. */
  modelId: readonly string[]
  /** The create card's route-id input. */
  routeId: readonly string[]
}

/** A row's identity as found on the page. */
interface FoundModel {
  /**
   * The official per-row disclosure container (`.modelAdvanced`, holding the
   * context-window / max-tokens fields) the picker mounts into. It exists
   * only while the row's "Capacities" disclosure is expanded, so a collapsed
   * row carries no picker at all.
   */
  container: HTMLElement
  /** The trigger's OWN model row element (row-scoped input reads). */
  row: HTMLElement
  /** The model id read from the row's "Model ID" input. */
  modelId: string
  /** The nearest card element (for route resolution). */
  card: HTMLElement
}

/** The join the injector renders from. */
export interface InjectorDeps {
  /** Read both namespaces plus writability (folded across scans). */
  describeNamespace(): Promise<SettingsJoin>
  /** Localized copy. */
  t: (key: string, params?: Record<string, unknown>) => string
  /** The official controls' aria-labels in the ACTIVE language (a thunk). */
  labels(): HostLabels
  /** Mount one picker into a disclosure container; render() updates its props in place. */
  mount(container: HTMLElement, props: SelectMountProps): MountedSelect
}

/** One mounted picker: unmount disposes the React root; render swaps props in place. */
export interface MountedSelect {
  unmount(): void
  render(props: SelectMountProps): void
}

/** Props handed to the picker mount for one model row. */
export interface SelectMountProps {
  /** The route being edited. */
  route: string
  /** The model id read from the row's own input. */
  modelId: string
  /** The model's stored pick, when one is set (`off` or an identity id). */
  value?: string
  /** The identities to offer (`id` only: the picker writes ids). */
  identities: readonly { id: string }[]
  /** Row ordinal among the models found in this scan (for aria labels). */
  index: number
  /** True while the row is unsaved (no settings row exists to write yet). */
  staged?: boolean
  readOnly: boolean
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Mutable scan state kept across reconcile invocations. */
export interface ScanState {
  /** Currently mounted pickers, keyed by their disclosure-container element. */
  mounted: Map<HTMLElement, { editor: MountedSelect; props: SelectMountProps; savedModelId: string | undefined }>
  /** Invalidation/disposal generation; stale async answers may not mount or clear newer reads. */
  generation: number
  /** The last describe promise, folded so scans never stack reads. */
  describePromise: Promise<SettingsJoin> | undefined
}

export function createScanState(): ScanState {
  return { mounted: new Map(), describePromise: undefined, generation: 0 }
}

/** Invalidate the folded read and every completion captured before this point. */
export function invalidateScanState(state: ScanState): void {
  state.generation += 1
  state.describePromise = undefined
}

/** Own-property membership over the providers dict (`in` would match prototype names). */
function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** Find the first input/select whose aria-label starts with one of the labels. */
function inputValueByLabel(scope: HTMLElement, labels: readonly string[]): string {
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[aria-label], select[aria-label]'))
  for (const label of labels) {
    const input = inputs.find(candidate => (candidate.getAttribute('aria-label') ?? '').startsWith(label))
    if (input !== undefined && input.value.trim().length > 0) return input.value.trim()
  }
  return ''
}

/** The nearest editor card element of a trigger. */
function cardOf(trigger: HTMLButtonElement): HTMLElement | undefined {
  return trigger.closest<HTMLElement>('[class*="editor"], [class*="rowCard"], [class*="addCard"]') ?? undefined
}

/** Whether a picker is already mounted in a container (idempotency guard). */
function hasPicker(container: HTMLElement, pluginId: string): boolean {
  return container.querySelector(`[data-plugin="${pluginId}"]`) !== null
}

/**
 * The official per-row disclosure container (holds the capacity fields). The
 * disclosure is rendered only while the row is expanded, so an absent
 * container means "collapsed" — the row is skipped and picked up by the next
 * scan after the user expands it.
 */
function disclosureOf(row: HTMLElement): HTMLElement | undefined {
  return row.querySelector<HTMLElement>('[class*="modelAdvanced"]') ?? undefined
}

/**
 * The model's stored pick as the select's own value: "Default" reads as absent
 * (the field is removed for it), `off` and identity ids ride verbatim.
 * @param providers - the pi-ai user-layer providers dict.
 * @param route - the provider route key.
 * @param modelId - the exact model id.
 */
function pickValueOf(providers: Record<string, Record<string, unknown>>, route: string, modelId: string): string | undefined {
  const pick = modelPickOf(providers, route, modelId)
  if (pick === 'default') return undefined
  return pick === 'off' ? 'off' : pick.identity
}

/** Semantic equality of two mount-prop sets (ends the render → mutation → scan cycle). */
function sameProps(a: SelectMountProps, b: SelectMountProps): boolean {
  return a.route === b.route
    && a.modelId === b.modelId
    && a.value === b.value
    && a.index === b.index
    && a.readOnly === b.readOnly
    && a.staged === b.staged
    && a.identities.length === b.identities.length
    && a.identities.every((identity, at) => identity.id === b.identities[at]?.id)
}

/** Whether the card carries any input/select labeled with one of the labels. */
function hasLabeledInput(card: HTMLElement, labels: readonly string[]): boolean {
  return Array.from(card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[aria-label], select[aria-label]'))
    .some(candidate => labels.some(label => (candidate.getAttribute('aria-label') ?? '').startsWith(label)))
}

/**
 * The route token of a card, resolved against the joined providers. The
 * official edit card prints the route key as the `.editorRoute` tag next to
 * the display-name title; the create card's "Provider ID" input carries the
 * route id being chosen — a route not in the settings document yet. Match
 * the key first (exact, unambiguous), then the create card's typed id, then
 * the display name, and finally the title itself as a route key (a provider
 * that never set a display name renders the route id as its title and hides
 * the `.editorRoute` tag). A create card never reaches the name/title arms —
 * its Provider ID input already returned.
 */
export function routeOfCard(
  card: HTMLElement,
  providers: Record<string, Record<string, unknown>>,
  labels: HostLabels,
): { route: string; staged: boolean } | undefined {
  const key = card.querySelector<HTMLElement>('[class*="editorRoute"]')?.textContent?.trim()
  if (key !== undefined && key.length > 0 && hasOwn(providers, key)) return { route: key, staged: false }
  if (hasLabeledInput(card, labels.routeId)) {
    const typed = inputValueByLabel(card, labels.routeId)
    return typed.length > 0 && !hasOwn(providers, typed) ? { route: typed, staged: true } : undefined
  }
  const title = card.querySelector<HTMLElement>('[class*="editorTitle"], [class*="rowName"]')?.textContent?.trim()
  if (title === undefined || title.length === 0) return undefined
  const byName = Object.entries(providers).find(([, profile]) => profile['displayName'] === title)
  if (byName !== undefined) return { route: byName[0], staged: false }
  if (hasOwn(providers, title)) return { route: title, staged: false }
  return undefined
}

/**
 * Scan the settings DOM for official model rows and reconcile the injected
 * pickers. Idempotent: existing pickers are left alone (re-rendered in place
 * when the document moved), new rows get one, and removed rows are
 * unmounted.
 * @param root - the settings panel root to scan.
 * @param deps - the injection dependencies.
 * @param state - mutable scan state shared across invocations.
 * @param pluginId - data-attribute guard value for the idempotency check.
 */
export function reconcile(root: HTMLElement, deps: InjectorDeps, state: ScanState, pluginId: string): void {
  if (!root.isConnected) return
  const labels = deps.labels()
  // Cheap DOM gate BEFORE the wire read: most mutations in a running app
  // fire while no model row exists at all.
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
  const hasCapacityRows = labels.capacity.some(aria =>
    buttons.some(button => (button.getAttribute('aria-label') ?? '').startsWith(aria)))
  if (!hasCapacityRows) {
    if (state.mounted.size > 0) {
      for (const [, entry] of state.mounted) entry.editor.unmount()
      state.mounted.clear()
    }
    return
  }
  // Fold the describe request across scans (one wire read per wave). The
  // holder clears this field on rejection (retry next scan) and on pushed
  // invalidations, so a stale snapshot never outlives the change that made
  // it stale.
  const generation = state.generation
  const promise = state.describePromise ??= deps.describeNamespace()
  const run = (join: SettingsJoin): void => {
    if (generation !== state.generation || !root.isConnected) return
    const providers = providersOf(join.piAi)
    // The picker offers the RESOLVED section's identities: the gate reads the
    // same resolved value, so an id the picker cannot show would be one the
    // gate cannot attach either.
    const gateValue = join.memoryGate === undefined ? undefined : join.memoryGate.value
    const identities = (isRecord(gateValue) && Array.isArray(gateValue['identities'])
      ? gateValue['identities'] as unknown[]
      : [])
      .flatMap((raw) => {
        const id = isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'].trim() : ''
        return id.length > 0 ? [{ id }] : []
      })

    const found = new Map<HTMLElement, FoundModel>()
    for (const aria of labels.capacity) {
      const triggers = Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
        .filter(button => (button.getAttribute('aria-label') ?? '').startsWith(aria))
      for (const trigger of triggers) {
        const row = trigger.closest<HTMLElement>('[class*="modelEntry"]')
        if (row === null) continue
        // Collapsed rows render no disclosure: nothing to mount into, and
        // nothing to show — the picker folds together with "Capacities".
        const container = disclosureOf(row)
        if (container === undefined) continue
        const card = cardOf(trigger)
        if (card === undefined) continue
        const modelId = inputValueByLabel(row, labels.modelId)
        if (modelId.length === 0) continue
        if (!found.has(container)) found.set(container, { container, row, modelId, card })
      }
    }

    // Unmount pickers whose disclosures are gone (a collapse un-renders the
    // container; a page re-render replaces it).
    for (const [key, entry] of state.mounted) {
      if (!found.has(key)) {
        entry.editor.unmount()
        state.mounted.delete(key)
      }
    }

    Array.from(found.values()).forEach((target, index) => {
      const resolved = routeOfCard(target.card, providers, labels)
      if (resolved === undefined) return
      const { route, staged: routeStaged } = resolved
      const models = modelsOf(providers, route)
      // Remember the saved identity of this DOM row. An input edit that turns
      // m1 into another already-saved id (m2) is still an uncommitted draft of
      // m1, not permission to write m2. A newly saved row adopts its id once it
      // appears in the settings document.
      const previous = state.mounted.get(target.container)
      let existing = previous
      if (existing !== undefined && !hasPicker(target.container, pluginId)) {
        existing.editor.unmount()
        state.mounted.delete(target.container)
        existing = undefined
      }
      const savedModelId = previous !== undefined && previous.props.route === route
        ? previous.savedModelId ?? (
          previous.props.staged === true && previous.props.modelId === target.modelId
          && models.some(model => model['id'] === target.modelId) ? target.modelId : undefined
        )
        : models.some(model => model['id'] === target.modelId) ? target.modelId : undefined
      const staged = routeStaged || savedModelId === undefined || savedModelId !== target.modelId
      const value = staged ? undefined : pickValueOf(providers, route, target.modelId)
      const next: SelectMountProps = {
        route,
        modelId: target.modelId,
        ...value === undefined ? {} : { value },
        identities,
        index,
        staged,
        readOnly: join.writable !== true,
        t: deps.t,
      }
      if (existing !== undefined) {
        existing.savedModelId = savedModelId
        if (!sameProps(existing.props, next)) {
          existing.props = next
          existing.editor.render(next)
        }
        return
      }
      if (hasPicker(target.container, pluginId)) return
      const editor = deps.mount(target.container, next)
      state.mounted.set(target.container, { editor, props: next, savedModelId })
    })
  }
  // A rejected describe must not permanently disable the injector: clear the
  // folded promise so the next scan retries the read.
  void promise.then(run, () => {
    if (generation === state.generation && state.describePromise === promise) state.describePromise = undefined
  })
}

/** Re-exported so the mount point can label the written field in diagnostics. */
export { MEMORY_GATE_FIELD }