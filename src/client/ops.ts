/**
 * Client-side settings seams over 'settings.mutate': reading both namespaces
 * this plugin joins on, writing one model's memory-gate pick onto its pi-ai
 * model row, and replacing the owned memory-gate section. Pure logic — no
 * React, no DOM — so it stays unit-testable in isolation.
 *
 * @module dsh-memory-gate/client/ops
 */

import { DSH_SESSION_HEADER, MEMORY_GATE_FIELD, MEMORY_GATE_NS, PI_AI_NS } from '../constants.js'
import { isRecord, normalizeSection, type IdentityProfile, type MemoryGateSection } from '../identities.js'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { RemoteApi, SettingsJoin, SettingsNamespaceView, WriteReply } from './types.js'

/**
 * Describe the pi-ai and memory-gate namespaces plus writability through the
 * settings Remote. The single describe seam for the browser half: the
 * injector's scan join, the model-pick write seam, and the identities card
 * all read through it (one wire call carries every namespace).
 */
export async function describeNamespaces(api: RemoteApi): Promise<SettingsJoin> {
  const response = await api.settings.describe()
  if (!response.ok) return { piAi: undefined, memoryGate: undefined, writable: false }
  return {
    piAi: response.value.namespaces.find(ns => ns.ns === PI_AI_NS),
    memoryGate: response.value.namespaces.find(ns => ns.ns === MEMORY_GATE_NS),
    writable: response.value.writable,
  }
}

/** The resolved section of a memory-gate namespace view. */
export function sectionOf(namespace: SettingsNamespaceView | undefined): MemoryGateSection {
  return normalizeSection(namespace?.value)
}

/** The empty identity a fresh editor row starts from (blank until the user types). */
export function newIdentity(): IdentityProfile {
  return { id: '', team: '', agent: '', task: '', headers: [{ name: '', value: '' }] }
}

/**
 * The non-identity findings the editor raises before a save reaches the host.
 * Identity-level problems come from the shared `validateIdentities`; these two
 * fields have no host validator (a blank header name would be silently
 * replaced by the defaults on normalize, and a dangling default identity would
 * silently detach memory), so the card gates them itself.
 */
export interface FieldIssues {
  /** Locale key of the header-name finding, when one exists. */
  headerName: 'issueHeaderNameEmpty' | 'issueHeaderNameInvalid' | 'issueHeaderNameDuplicate' | 'issueHeaderNameReserved' | null
  /** Whether the default identity names an id absent from the list. */
  defaultMissing: boolean
}

/**
 * Check the three configured header names against the rules the host enforces
 * at save time, so the card can refuse a save the host would reject anyway.
 * @param names - the configured header names, already trimmed.
 * @returns the locale key of the first failing rule, or null.
 */
function headerNameIssue(names: string[]): FieldIssues['headerName'] {
  if (names.some(name => name.length === 0)) return 'issueHeaderNameEmpty'
  if (!names.every(name => headerNameValid(name))) return 'issueHeaderNameInvalid'
  // The session header is the conversation key: a fixed value there would merge
  // every session into one proxy conversation.
  if (names.some(name => name.toLowerCase() === DSH_SESSION_HEADER.toLowerCase())) return 'issueHeaderNameReserved'
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) return 'issueHeaderNameDuplicate'
  return null
}

/** Whether a header NAME is representable as a Fetch header (the host's save-time rule). */
function headerNameValid(name: string): boolean {
  try {
    new Headers().set(name, '')
    return true
  } catch {
    return false
  }
}

/**
 * Check the section-wide fields the host does not validate itself.
 * @param section - the staged section.
 */
export function fieldIssuesOf(section: MemoryGateSection): FieldIssues {
  const names = [section.headerNames.team, section.headerNames.agent, section.headerNames.task]
  const namesTrimmed = names.map(name => name.trim())
  const headerName = headerNameIssue(namesTrimmed)
  const defaultId = section.defaultIdentity.trim()
  const defaultMissing = defaultId.length > 0
    && !section.identities.some(identity => identity.id.trim().toLowerCase() === defaultId.toLowerCase())
  return { headerName, defaultMissing }
}

/** The distinct identity ids in the section, trimmed and case-deduplicated (first spelling wins). */
export function identityIdsOf(section: MemoryGateSection): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const identity of section.identities) {
    const id = identity.id.trim()
    const key = id.toLowerCase()
    if (id.length === 0 || seen.has(key)) continue
    seen.add(key)
    ids.push(id)
  }
  return ids
}

/** Semantic equality of two staged/loaded sections. */
export function sameSection(a: MemoryGateSection, b: MemoryGateSection): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The user-layer providers dict of the pi-ai namespace, as records. */
export function providersOf(namespace: SettingsNamespaceView | undefined): Record<string, Record<string, unknown>> {
  const value = namespace?.value as { providers?: unknown } | undefined
  const providers = value?.providers
  if (!isRecord(providers)) return {}
  return Object.fromEntries(
    Object.entries(providers).filter(([, profile]) => isRecord(profile)),
  ) as Record<string, Record<string, unknown>>
}

/**
 * One `set` op. A settings document is JSON, and every field this module
 * writes is staged from that document, so the value is JSON-shaped by
 * construction; the assertion replaces a per-field rebuild of the wire type.
 */
function setOp(path: string[], value: unknown): SettingsPathOpView {
  return { op: 'set', path, value } as unknown as SettingsPathOpView
}

/**
 * Write one model's memory-gate pick onto its pi-ai model row: a value sets
 * the field (`off`, `default`, or an identity id), `null` removes it ("Default"
 * / inherit). The models array is rebuilt verbatim; a row this code cannot
 * represent refuses the write rather than silently dropping it. Retried once
 * on a revision conflict (a concurrent writer moved the namespace between
 * describe and mutate) — the same recovery the official settings form uses.
 * @param api - the settings Remote face.
 * @param route - the provider route key.
 * @param modelId - the exact model id.
 * @param pick - the field value, or null to remove it.
 * @param describe - how to obtain the namespaces join (injectable for tests).
 */
export async function writeModelPick(
  api: RemoteApi,
  route: string,
  modelId: string,
  pick: string | null,
  describe: () => Promise<SettingsJoin> = () => describeNamespaces(api),
): Promise<WriteReply> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const join = await describe()
      if (join.piAi === undefined) return { ok: false, error: 'no-namespace' }
      if (!join.writable) return { ok: false, error: 'read-only' }
      const providers = providersOf(join.piAi)
      const rawModels = providers[route]?.['models']
      if (!Array.isArray(rawModels)) return { ok: false, error: 'model-not-found' }
      if (!rawModels.every(isRecord)) return { ok: false, error: 'invalid-models' }
      const models = rawModels as Record<string, unknown>[]
      const index = models.findIndex(model => model['id'] === modelId)
      if (index < 0) return { ok: false, error: 'model-not-found' }
      const nextModels = models.map((model, at) => {
        if (at !== index) return model
        const copy = { ...model }
        if (pick === null) delete copy[MEMORY_GATE_FIELD]
        else copy[MEMORY_GATE_FIELD] = pick
        return copy
      })
      const response = await api.settings.mutate(
        PI_AI_NS,
        [setOp(['providers', route, 'models'], nextModels)],
        join.piAi.revision,
      )
      if (!response.ok) {
        // The stable wire code, not the message prose: 'settings/conflict'
        // means a concurrent writer moved the namespace between our describe
        // and mutate; re-read once and retry with the fresh revision.
        if (attempt === 0 && response.error.code === 'settings/conflict') continue
        return { ok: false, error: response.error.message }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: false, error: 'conflict' }
}

/**
 * The section as it is written: ids and header names trimmed, fully-blank
 * extra header rows dropped (they are editing artifacts the editor leaves
 * behind). Nothing else is
 * coerced — the host's registration validator is the gate for invalid data,
 * and its refusal is surfaced verbatim.
 * @param section - the staged section.
 */
export function cleanSection(section: MemoryGateSection): MemoryGateSection {
  return {
    identities: section.identities.map(identity => ({
      id: identity.id.trim(),
      team: identity.team.trim(),
      agent: identity.agent.trim(),
      task: identity.task.trim(),
      headers: identity.headers
        .filter(entry => entry.name.trim().length > 0 || entry.value.length > 0)
        .map(entry => ({ name: entry.name.trim(), value: entry.value })),
    })),
    defaultIdentity: section.defaultIdentity.trim(),
    headerNames: {
      team: section.headerNames.team.trim(),
      agent: section.headerNames.agent.trim(),
      task: section.headerNames.task.trim(),
    },
    sessionHeader: section.sessionHeader,
    trustedOrigins: [...section.trustedOrigins],
  }
}

/**
 * Replace the owned memory-gate section wholesale (one save of the
 * configuration card): all five fields ride in one mutation, so an editor
 * that changed the default identity and the list together lands atomically.
 * Without an explicit baseline revision, a conflict is retried once against a
 * fresh snapshot; a baselined card draft never retries over an external
 * writer.
 * @param api - the settings Remote face.
 * @param section - the staged section.
 * @param describe - how to obtain the namespaces join (injectable for tests).
 * @param expectedRevision - the revision the draft was based on. When
 *   supplied, a conflict is returned without retrying stale data over a newer
 *   external writer.
 */
export async function writeSection(
  api: RemoteApi,
  section: MemoryGateSection,
  describe: () => Promise<SettingsJoin> = () => describeNamespaces(api),
  expectedRevision?: number,
): Promise<WriteReply> {
  const cleaned = cleanSection(section)
  const ops = [
    setOp(['identities'], cleaned.identities),
    setOp(['defaultIdentity'], cleaned.defaultIdentity),
    setOp(['headerNames'], cleaned.headerNames),
    setOp(['sessionHeader'], cleaned.sessionHeader),
    setOp(['trustedOrigins'], cleaned.trustedOrigins),
  ]
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const join = await describe()
      if (join.memoryGate === undefined) return { ok: false, error: 'no-namespace' }
      const response = await api.settings.mutate(
        MEMORY_GATE_NS,
        ops,
        attempt === 0 ? expectedRevision ?? join.memoryGate.revision : join.memoryGate.revision,
      )
      if (!response.ok) {
        if (expectedRevision === undefined && attempt === 0 && response.error.code === 'settings/conflict') continue
        return { ok: false, error: response.error.message }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: false, error: 'conflict' }
}