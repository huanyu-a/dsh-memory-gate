/**
 * The per-model memory-identity picker mounted into the official Models
 * page's model rows (the provider card's "模型目录" / model catalog): a
 * compact select offering 默认/Default (inherit the default identity), 摘链
 * (detach: no identity header at all) plus every memory identity id.
 * Choosing one writes the pick onto the model's pi-ai settings row; Default
 * removes it.
 *
 * @module dsh-memory-gate/client/ModelGateSelect
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { MgKey } from './locales.js'
import type { WriteReply } from './types.js'

/** Translate face the picker consumes. */
export type SelectTranslate = (key: MgKey, params?: Record<string, unknown>) => string

/** Props the injector hands to one mounted picker. */
export interface ModelGateSelectProps {
  /** The route being edited. */
  route: string
  /** The model id read from the row's own input. */
  modelId: string
  /** The model's stored pick: `off`, an identity id, or absent for Default. */
  value?: string
  /** The identities to offer (ids, canonical case). */
  identities: readonly { id: string }[]
  /** True while the settings document refuses writes. */
  readOnly: boolean
  /**
   * True while the row is unsaved (a create card's draft route, or a new
   * model row on a saved route): there is no settings row to write yet, so
   * the picker mounts disabled with an explanatory tooltip.
   */
  staged?: boolean
  /** Row ordinal among the models found in this scan (for aria labels). */
  index: number
  t: SelectTranslate
  /** Write the pick (`off`, an identity id, or null for Default). */
  onPick(route: string, modelId: string, pick: string | null): Promise<WriteReply>
}

/** Render one model row's memory-identity picker. */
export function ModelGateSelect(props: ModelGateSelectProps): ReactNode {
  const { t } = props
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const statusId = useId()
  const stored = props.value ?? ''
  // `off` is the value the gate parses as "detach"; anything else is an
  // identity id, canonicalized to the stored casing when the identity exists.
  const detached = stored.trim().toLowerCase() === 'off'
  const canonical = props.identities.find(identity => identity.id.trim().toLowerCase() === stored.trim().toLowerCase())
  const value = detached ? 'off' : canonical?.id ?? stored
  const missing = !detached && stored.trim().length > 0 && canonical === undefined
  const disabled = props.readOnly || props.staged === true || saving
  const title = props.staged === true
    ? t('modelPickerSaveFirst')
    : failed !== null
      ? `${t('modelPickerWriteFailed')}: ${failed}`
      : t('modelPicker')
  const status = props.staged === true
    ? t('modelPickerSaveFirst')
    : failed !== null ? `${t('modelPickerWriteFailed')}: ${failed}` : null

  const onChange = async (next: string): Promise<void> => {
    setSaving(true)
    setFailed(null)
    try {
      const reply = await props.onPick(props.route, props.modelId, next === '' ? null : next)
      if (!reply.ok) {
        setFailed(reply.error)
        console.error(`[dsh-memory-gate] pick write failed for "${props.route}/${props.modelId}": ${reply.error}`)
      }
      // On success the document-updated invalidation re-scans and the next
      // props carry the stored pick; nothing optimistic to commit here.
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="mg-select" data-failed={failed !== null ? 'true' : undefined}>
      <span className="mg-field-label">{t('modelPicker')}</span>
      <select
        className="mg-select-input"
        aria-label={`${t('modelPicker')}: ${props.modelId}`}
        title={title}
        aria-describedby={status === null ? undefined : statusId}
        value={value}
        disabled={disabled}
        onChange={(event) => { void onChange(event.target.value) }}
      >
        <option value="">{t('modelPickerDefault')}</option>
        <option value="off">{t('modelPickerDetached')}</option>
        {props.identities.map(identity => (
          <option key={identity.id} value={identity.id}>{identity.id}</option>
        ))}
        {missing
          // The stored pick names an identity that no longer exists: keep it
          // visible (and correctable) instead of silently showing Default.
          ? <option value={value}>{value} (?)</option>
          : null}
      </select>
      {status === null ? null : <span id={statusId} className="mg-select-status" role="status">{status}</span>}
    </span>
  )
}