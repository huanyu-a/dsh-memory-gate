/**
 * The section-wide field groups of the memory-gate card: the default identity
 * (chosen from the staged list), the three identity header names and the
 * session-header switch. Presentational only — the card owns the
 * draft and passes a single `onPatch` for section-shape edits, so the dirty
 * flag, the revision baseline and the save path stay in one component.
 *
 * @module dsh-memory-gate/client/SectionFields
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import type { MemoryGateSection } from '../identities.js'
import type { CardTranslate } from './locales.js'
import type { FieldIssues } from './ops.js'

/** Props every section-wide field group shares. */
interface SectionFieldBase {
  /** The staged section. */
  section: MemoryGateSection
  /** True while writes are refused or a save is in flight. */
  disabled: boolean
  t: CardTranslate
  /** Stage a section-shape patch. */
  onPatch(fields: Partial<MemoryGateSection>): void
}

/** Props the card binds for the section-wide fields. */
export interface DefaultIdentityProps extends SectionFieldBase {
  /** Distinct identity ids of the staged list, in first-seen spelling. */
  identities: readonly string[]
  /** The section-wide findings (the dangling-default flag is read). */
  issues: FieldIssues
}

/**
 * The default identity: every model without its own pick inherits it. The
 * options come from the staged list, so an id the same save adds is
 * immediately selectable; a default that names a missing id keeps its own
 * text (marked) instead of silently reading as "no default".
 */
export function DefaultIdentityField(props: DefaultIdentityProps): ReactNode {
  const { t, section, identities, issues, disabled } = props
  const selectId = useId()
  const stored = section.defaultIdentity.trim()
  const canonical = identities.find(id => id.toLowerCase() === stored.toLowerCase()) ?? stored
  return (
    <>
      <h4 className="mg-section-title">{t('sectionDefaults')}</h4>
      <div className="mg-field">
        <label className="mg-label" htmlFor={selectId}>{t('defaultIdentity')}</label>
        <select
          id={selectId}
          className={`mg-input mg-input-select${issues.defaultMissing ? ' mg-input-invalid' : ''}`}
          value={canonical}
          disabled={disabled}
          onChange={(event) => { props.onPatch({ defaultIdentity: event.target.value }) }}
        >
          <option value="">{t('defaultIdentityNone')}</option>
          {identities.map(id => <option key={id} value={id}>{id}</option>)}
          {issues.defaultMissing ? <option value={stored}>{stored} (?)</option> : null}
        </select>
      </div>
      {issues.defaultMissing ? <p className="mg-issue" role="alert">{t('issueDefaultMissing')}</p> : null}
    </>
  )
}

/** Props of the header-name group. */
export interface HeaderNamesProps extends SectionFieldBase {
  /** The header-name finding only (the dangling-default flag is ignored here). */
  invalid: FieldIssues['headerName']
}

/**
 * The three identity header names. Deployments may rename them, and the
 * values are what the gate actually writes, so the names are edited rather
 * than hard-coded.
 */
export function HeaderNamesField(props: HeaderNamesProps): ReactNode {
  const { t, section, disabled, invalid } = props
  const patchName = (field: 'team' | 'agent' | 'task', value: string): void => {
    props.onPatch({ headerNames: { ...section.headerNames, [field]: value } })
  }
  return (
    <>
      <h4 className="mg-section-title">{t('headerNamesTitle')}</h4>
      <div className="mg-triple">
        <label className="mg-field">
          <span className="mg-label">{t('headerTeamName')}</span>
          <input
            className={`mg-input${invalid === 'issueHeaderNameInvalid' ? ' mg-input-invalid' : ''}`}
            type="text"
            value={section.headerNames.team}
            placeholder="x-team-id"
            disabled={disabled}
            onChange={(event) => { patchName('team', event.target.value) }}
          />
        </label>
        <label className="mg-field">
          <span className="mg-label">{t('headerAgentName')}</span>
          <input
            className="mg-input"
            type="text"
            value={section.headerNames.agent}
            placeholder="x-agent-id"
            disabled={disabled}
            onChange={(event) => { patchName('agent', event.target.value) }}
          />
        </label>
        <label className="mg-field">
          <span className="mg-label">{t('headerTaskName')}</span>
          <input
            className="mg-input"
            type="text"
            value={section.headerNames.task}
            placeholder="x-task-id"
            disabled={disabled}
            onChange={(event) => { patchName('task', event.target.value) }}
          />
        </label>
      </div>
      {invalid === null ? null : <p className="mg-issue" role="alert">{t(invalid)}</p>}
    </>
  )
}

/** Props of the session group. */
export interface PolicyFieldsProps extends SectionFieldBase {}

/**
 * Approved origins and the switch controlling the harness session header.
 * Keep origin lines verbatim so invalid drafts reach the host validator.
 */
export function PolicyFields(props: PolicyFieldsProps): ReactNode {
  const { t, section, disabled } = props
  const originsId = useId()
  const originsHelpId = useId()
  return (
    <>
      <h4 className="mg-section-title">{t('sectionPolicy')}</h4>
      <div className="mg-field">
        <label className="mg-label" htmlFor={originsId}>{t('trustedOrigins')}</label>
        <textarea
          id={originsId}
          className="mg-input"
          rows={3}
          value={section.trustedOrigins.join('\n')}
          disabled={disabled}
          aria-describedby={originsHelpId}
          onChange={(event) => {
            const value = event.target.value
            props.onPatch({ trustedOrigins: value === '' ? [] : value.split(/\r?\n/) })
          }}
        />
        <p id={originsHelpId} className="mg-hint">{t('trustedOriginsHint')}</p>
      </div>
      <label className="mg-check">
        <input
          type="checkbox"
          checked={section.sessionHeader}
          disabled={disabled}
          onChange={(event) => { props.onPatch({ sessionHeader: event.target.checked }) }}
        />
        <span>{t('sessionHeader')}</span>
      </label>
      <p className="mg-hint">{t('sessionHeaderHint')}</p>
    </>
  )
}