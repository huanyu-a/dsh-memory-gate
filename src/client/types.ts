/**
 * Wire-surface types the browser half consumes: the settings Remote faces and
 * the slots/locale seams. The consumed wire baseline is the 0.1.5-rc.2
 * kernel (the development cohort compiles against the newest adapted host —
 * currently 0.2.2-rc.1 — whose stub keeps this shape): the browser talks to
 * the generated Typert `ctx.remote.settings` stub — `describe()` takes no
 * argument, `mutate` takes positional `(ns, ops, expectedRevision)`, and
 * every answer is the envelope `{ok, value | error}` with refusals coded
 * `settings/conflict` / `settings/rejected` / `gateway/*`.
 *
 * @module dsh-memory-gate/client/types
 */

import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'

/** The settings answer envelope, in the official `RemoteResult` shape. */
export type SettingsRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/** The 'settings' Remote methods the browser half calls (Typert shape). */
export interface SettingsRemoteApi {
  describe(): Promise<SettingsRemoteResult<SettingsDescribeValue>>
  mutate(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision?: number,
  ): Promise<SettingsRemoteResult<SettingsNamespaceView>>
}

/** The Remote faces the browser half consumes. */
export interface RemoteApi {
  settings: SettingsRemoteApi
}

export type { SettingsNamespaceView, SettingsPathOpView }

/**
 * The join the browser half renders from: the pi-ai namespace (model rows and
 * their memory-gate picks), the owned memory-gate namespace (the identities
 * themselves), and writability of the settings document.
 */
export interface SettingsJoin {
  /** The pi-ai namespace view, when registered. */
  piAi: SettingsNamespaceView | undefined
  /** The memory-gate namespace view, when registered. */
  memoryGate: SettingsNamespaceView | undefined
  /** Whether the settings document accepts writes. */
  writable: boolean
}

/**
 * The client shell's context face, declared locally instead of imported: the
 * assembly packages merge their services into cordis' `Context`, but a
 * third-party client contribution pins only the members it calls.
 */
export interface ClientContext {
  locale: {
    register(ns: string, dict: Record<string, unknown>): unknown
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    /**
     * LocaleFace pair: the revision moves on every active-language switch
     * and dictionary registration.
     */
    subscribe?(fn: () => void): () => void
    getSnapshot?(): { revision?: number }
  }
  remote: {
    $on(event: 'settings/document-updated', listener: (ns: unknown, revision?: number) => void): () => void
    settings: SettingsRemoteApi
  }
  on(event: 'connection/reset', listener: () => void): () => void
  effect(fn: () => unknown, name?: string): unknown
}

/**
 * Minimal 'ctx.slots' face the plugin-configuration card registration needs.
 * The runtime accepts these calls; the structural declaration keeps the
 * plugin's slot seam independent of the slots package's own type surface.
 */
export interface SlotRegistrarFace {
  inject(name: string, registrar: () => unknown): unknown
  register(options: {
    name: string
    key?: string
    id?: string
    order?: number
    locale?: string
    inject?: () => Record<string, unknown>
    [extra: string]: unknown
  }, component: unknown): () => void
  /** Current entries of one slot, in ledger (registration) order. */
  entries(name: string): ReadonlyArray<{ options?: { key?: string; id?: string; order?: number } }>
  /** Observe one slot's ledger changes; returns the disposer. */
  subscribe(name: string, listener: () => void): () => void
}

/** One result of a settings write. */
export type WriteReply = { ok: true } | { ok: false; error: string }