/**
 * The `memory-gate` card inside the official "Plugin configuration"
 * (插件配置) tab: one permanently expanded card, registered into the plugin's
 * own configuration slot keyed by the namespace it edits. The chrome is a 1:1
 * port of the official PluginCard (header, notes, save/discard footer).
 *
 * The card is the stateful shell of the editor: it loads the section through
 * the settings Remote, owns the draft and its revision baseline, and composes
 * the three presentational blocks. The whole section saves in ONE mutation —
 * all five fields ride together — so a default identity can never point at an
 * identity the same save removed.
 *
 * @module dsh-memory-gate/client/MemoryGateCard
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { validateIdentities, type IdentityProfile, type MemoryGateSection } from '../identities.js'
import {
  describeNamespaces,
  fieldIssuesOf,
  identityIdsOf,
  newIdentity,
  sameSection,
  sectionOf,
  writeSection,
  type FieldIssues,
} from './ops.js'
import type { CardTranslate } from './locales.js'
import { IdentityList } from './IdentityEditor.tsx'
import { DefaultIdentityField, HeaderNamesField, PolicyFields } from './SectionFields.tsx'
import type { RemoteApi } from './types.js'

/** Props the slot registration binds: the locale seat plus the injected face. */
export interface MemoryGateCardProps {
  t: CardTranslate
  /** The settings Remote face (injected by the slot entry). */
  api: RemoteApi
  /**
   * Subscribe to external invalidations of the memory-gate namespace
   * (another surface's save, a reconnect). Returns the disposer.
   */
  subscribe(listener: () => void): () => void
}

/** The field findings of an empty section (used before the first load lands). */
const NO_ISSUES: FieldIssues = { headerName: null, budget: null, defaultMissing: false }

/**
 * Render the memory-gate card. Renders nothing while the namespace join has
 * not loaded — the tab only dispatches served namespaces, so a missing answer
 * is a transient (or a read-only mirror), not an empty form.
 */
export function MemoryGateCard(props: MemoryGateCardProps): ReactNode {
  const { t, api, subscribe } = props
  const [loaded, setLoaded] = useState<MemoryGateSection | undefined>(undefined)
  const [loadedRevision, setLoadedRevision] = useState<number | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [draft, setDraft] = useState<MemoryGateSection | null>(null)
  /**
   * Per-identity disclosure flags, kept index-aligned with the identities
   * list. Loaded identities start collapsed (only the ID shows); a freshly
   * added identity starts expanded so its empty id field is immediately
   * editable.
   */
  const [openIdentities, setOpenIdentities] = useState<boolean[]>([])
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const draftRef = useRef<MemoryGateSection | null>(null)
  const loadGeneration = useRef(0)
  const mounted = useRef(false)
  const reload = useRef<() => void>(() => {})
  draftRef.current = draft

  // Load on first render, and follow external invalidations. A dirty draft
  // survives a reload without rebasing it: a later save still uses the
  // draft's original revision, so an external writer causes a visible conflict
  // instead of being silently overwritten. Discard reloads the latest baseline.
  useEffect(() => {
    mounted.current = true
    const load = async (): Promise<void> => {
      const generation = ++loadGeneration.current
      const join = await describeNamespaces(api)
      if (!mounted.current || generation !== loadGeneration.current) return
      setWritable(join.writable)
      if (join.memoryGate === undefined || draftRef.current !== null) return
      setLoaded(sectionOf(join.memoryGate))
      setLoadedRevision(join.memoryGate.revision)
    }
    reload.current = () => { void load() }
    void load()
    const unsubscribe = subscribe(() => { void load() })
    return () => {
      mounted.current = false
      loadGeneration.current += 1
      reload.current = () => {}
      unsubscribe()
    }
  }, [api, subscribe])

  const current = draft ?? loaded
  const dirty = draft !== null && loaded !== undefined && !sameSection(draft, loaded)
  const issues = useMemo(
    () => (current === undefined ? [] : validateIdentities(current)),
    [current],
  )
  const fieldIssues = useMemo<FieldIssues>(
    () => (current === undefined ? NO_ISSUES : fieldIssuesOf(current)),
    [current],
  )
  const identityIds = useMemo(
    () => (current === undefined ? [] : identityIdsOf(current)),
    [current],
  )

  if (loaded === undefined || current === undefined) return null

  const edit = (next: MemoryGateSection): void => {
    setDraft(next)
    setFailed(null)
  }
  const patch = (fields: Partial<MemoryGateSection>): void => { edit({ ...current, ...fields }) }
  const replaceIdentity = (at: number, next: IdentityProfile): void => {
    edit({ ...current, identities: current.identities.map((identity, index) => (index === at ? next : identity)) })
  }
  const toggleIdentity = (at: number): void => {
    setOpenIdentities((flags) => {
      const next = flags.slice(0)
      while (next.length <= at) next.push(false)
      next[at] = !next[at]
      return next
    })
  }
  const addIdentity = (): void => {
    edit({ ...current, identities: [...current.identities, newIdentity()] })
    // A new identity starts expanded: its empty id needs immediate editing.
    setOpenIdentities((flags) => {
      const next = flags.slice(0, current.identities.length)
      while (next.length < current.identities.length) next.push(false)
      next.push(true)
      return next
    })
  }
  const removeIdentity = (at: number): void => {
    const removed = current.identities[at]
    // Removing the identity the default names would leave a dangling default;
    // clear it in the same draft so the section stays internally consistent.
    const clearsDefault = removed !== undefined
      && removed.id.trim().toLowerCase() === current.defaultIdentity.trim().toLowerCase()
    patch({
      identities: current.identities.filter((_, index) => index !== at),
      ...clearsDefault ? { defaultIdentity: '' } : {},
    })
    setOpenIdentities((flags) => flags.filter((_, index) => index !== at))
  }

  const onSave = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setFailed(null)
    try {
      const reply = await writeSection(api, current, undefined, loadedRevision)
      if (!mounted.current) return
      if (reply.ok) {
        draftRef.current = null
        setDraft(null)
        const generation = ++loadGeneration.current
        const join = await describeNamespaces(api)
        if (!mounted.current || generation !== loadGeneration.current) return
        setWritable(join.writable)
        if (join.memoryGate !== undefined) {
          setLoaded(sectionOf(join.memoryGate))
          setLoadedRevision(join.memoryGate.revision)
        }
      } else {
        setFailed(reply.error)
        console.error(`[dsh-memory-gate] section save failed: ${reply.error}`)
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  const onDiscard = (): void => {
    draftRef.current = null
    setDraft(null)
    setFailed(null)
    setOpenIdentities((flags) => flags.map(() => false))
    reload.current()
  }

  const disabled = !writable || saving
  // Every gate the host would refuse is closed here first: a dangling identity
  // would detach its sessions, a blank header name would be replaced by the
  // defaults, and a non-positive ceiling would detach every new session.
  const blocked = !writable || !dirty || saving
    || issues.length > 0
    || fieldIssues.headerName !== null
    || fieldIssues.budget !== null
    || fieldIssues.defaultMissing

  return (
    <li className="mg-card mg-card-open">
      <div className="mg-card-header">
        <span className="mg-head-text">
          <span className="mg-card-name">{t('cardTitle')}</span>
          <span className="mg-card-description">{t('cardDescription')}</span>
        </span>
        {dirty ? <span className="mg-tag">{t('unsaved')}</span> : null}
      </div>
      <div className="mg-card-body">
        {!writable ? <p className="mg-readonly" role="status">{t('readOnly')}</p> : null}
        <div className="mg-notes">
          <p className="mg-hint">{t('proxyNote')}</p>
          <p className="mg-hint">{t('pinnedNote')}</p>
          <p className="mg-hint">{t('detachNote')}</p>
        </div>

        <h4 className="mg-section-title">{t('sectionIdentities')}</h4>
        <IdentityList
          identities={current.identities}
          issues={issues}
          open={openIdentities}
          disabled={disabled}
          t={t}
          onToggle={toggleIdentity}
          onChange={replaceIdentity}
          onRemove={removeIdentity}
          onAdd={addIdentity}
        />

        <DefaultIdentityField
          section={current}
          identities={identityIds}
          issues={fieldIssues}
          disabled={disabled}
          t={t}
          onPatch={patch}
        />
        <HeaderNamesField
          section={current}
          disabled={disabled}
          invalid={fieldIssues.headerName}
          t={t}
          onPatch={patch}
        />
        <PolicyFields
          section={current}
          disabled={disabled}
          invalid={fieldIssues.budget}
          t={t}
          onPatch={patch}
        />

        <div className="mg-card-footer">
          {failed !== null ? <p className="mg-failed" role="status">{`${t('saveFailed')} (${failed})`}</p> : null}
          <button
            type="button"
            className="mg-button"
            disabled={!dirty || saving}
            onClick={onDiscard}
          >
            {t('discard')}
          </button>
          <button
            type="button"
            className="mg-button mg-button-primary"
            disabled={blocked}
            onClick={() => { void onSave() }}
          >
            {t(saving ? 'saving' : 'save')}
          </button>
        </div>
      </div>
    </li>
  )
}