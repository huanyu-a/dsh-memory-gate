/**
 * The identity editor block of the memory-gate card: the list of named
 * identities, each its own disclosure (collapsed it shows just the ID;
 * expanding reveals the id field, the identity triple the proxy reads —
 * team / agent / task — and the extra header rows with their + / − buttons).
 * Presentational only: the card owns the draft and hands in the staged list
 * plus one `onChange` per identity, so every keystroke is one whole-identity
 * replacement and the card's dirty/revision bookkeeping stays in one place.
 *
 * @module dsh-memory-header-gate/client/IdentityEditor
 */

import type { ReactNode } from 'react'
import type { HeaderEntry, IdentityIssue, IdentityProfile } from '../identities.js'
import type { CardTranslate, MgKey } from './locales.js'

/** Props the card binds for the identity list. */
export interface IdentityListProps {
  /** The staged identity list. */
  identities: readonly IdentityProfile[]
  /** Every validation finding of the staged section (`validateIdentities`). */
  issues: readonly IdentityIssue[]
  /** Per-identity disclosure flags, index-aligned with `identities`. */
  open: readonly boolean[]
  /** True while writes are refused or a save is in flight. */
  disabled: boolean
  t: CardTranslate
  /** Toggle one identity's disclosure. */
  onToggle(at: number): void
  /** Replace one staged identity wholesale. */
  onChange(at: number, next: IdentityProfile): void
  /** Remove one staged identity (the card also clears a dangling default). */
  onRemove(at: number): void
  /** Append a blank identity (already expanded by the card). */
  onAdd(): void
}

/** The official ic_ds_chevron_down_outline_14 icon (verbatim path). */
function ChevronIcon(props: { open: boolean }): ReactNode {
  return (
    <span className={`mg-chevron${props.open ? ' mg-chevron-open' : ''}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
          fill="currentColor"
        />
      </svg>
    </span>
  )
}

/** Group validation findings by identity index for per-field rendering. */
function issuesByIdentity(issues: readonly IdentityIssue[]): Map<number, IdentityIssue[]> {
  const map = new Map<number, IdentityIssue[]>()
  for (const issue of issues) {
    const list = map.get(issue.identity) ?? []
    list.push(issue)
    map.set(issue.identity, list)
  }
  return map
}

/** The locale key of one validation finding. */
function issueKey(code: IdentityIssue['code']): MgKey {
  switch (code) {
    case 'id-empty': return 'issueIdEmpty'
    case 'id-duplicate': return 'issueIdDuplicate'
    case 'team-empty': return 'issueTeamEmpty'
    case 'name-empty': return 'issueNameEmpty'
    case 'name-invalid': return 'issueNameInvalid'
    case 'name-reserved': return 'issueNameReserved'
    case 'name-conflict': return 'issueNameConflict'
    case 'name-duplicate': return 'issueNameDuplicate'
    case 'value-invalid': return 'issueValueInvalid'
  }
}

/** Render the identity list: one disclosure per identity plus the add button. */
export function IdentityList(props: IdentityListProps): ReactNode {
  const { t, identities, open, disabled } = props
  const grouped = issuesByIdentity(props.issues)

  const patchRow = (at: number, row: number, fields: Partial<HeaderEntry>): void => {
    const identity = identities[at]
    if (identity === undefined) return
    props.onChange(at, {
      ...identity,
      headers: identity.headers.map((entry, atRow) => (atRow === row ? { ...entry, ...fields } : entry)),
    })
  }

  return (
    <>
      {identities.length === 0 ? <p className="mg-empty">{t('emptyIdentities')}</p> : null}
      {identities.map((identity, at) => {
        const identityOpen = open[at] === true
        const identityIssues = grouped.get(at) ?? []
        const idIssue = identityIssues.find(issue => issue.row === undefined
          && (issue.code === 'id-empty' || issue.code === 'id-duplicate'))
        const teamIssue = identityIssues.find(issue => issue.code === 'team-empty')
        const title = identity.id.trim()
        return (
          <section className="mg-identity" key={at}>
            <div className="mg-identity-head">
              <button
                type="button"
                className="mg-identity-toggle"
                aria-expanded={identityOpen}
                aria-label={`${t(identityOpen ? 'collapseIdentity' : 'expandIdentity')}: ${title.length > 0 ? title : t('identityUntitled')}`}
                onClick={() => { props.onToggle(at) }}
              >
                <ChevronIcon open={identityOpen} />
                <span className={`mg-identity-title${title.length === 0 ? ' mg-identity-title-unset' : ''}`}>
                  {title.length > 0 ? title : t('identityUntitled')}
                </span>
              </button>
              <button
                type="button"
                className="mg-button mg-button-small"
                aria-label={`${t('removeIdentity')} ${String(at + 1)}`}
                disabled={disabled}
                onClick={() => { props.onRemove(at) }}
              >
                {t('removeIdentity')}
              </button>
            </div>
            {identityOpen
              ? (
                <div className="mg-identity-body">
                  <label className="mg-field">
                    <span className="mg-label">{t('identityId')}</span>
                    <input
                      className={`mg-input${idIssue !== undefined ? ' mg-input-invalid' : ''}`}
                      type="text"
                      value={identity.id}
                      placeholder={t('identityIdPlaceholder')}
                      aria-label={`${t('identityId')} ${String(at + 1)}`}
                      disabled={disabled}
                      onChange={(event) => { props.onChange(at, { ...identity, id: event.target.value }) }}
                    />
                  </label>
                  {idIssue !== undefined
                    ? <p className="mg-issue" role="alert">{t(issueKey(idIssue.code))}</p>
                    : null}
                  <div className="mg-triple">
                    <label className="mg-field">
                      <span className="mg-label">{t('teamValue')}</span>
                      <input
                        className={`mg-input${teamIssue !== undefined ? ' mg-input-invalid' : ''}`}
                        type="text"
                        value={identity.team}
                        placeholder={t('teamPlaceholder')}
                        disabled={disabled}
                        onChange={(event) => { props.onChange(at, { ...identity, team: event.target.value }) }}
                      />
                    </label>
                    <label className="mg-field">
                      <span className="mg-label">{t('agentValue')}</span>
                      <input
                        className="mg-input"
                        type="text"
                        value={identity.agent}
                        placeholder={t('agentPlaceholder')}
                        disabled={disabled}
                        onChange={(event) => { props.onChange(at, { ...identity, agent: event.target.value }) }}
                      />
                    </label>
                    <label className="mg-field">
                      <span className="mg-label">{t('taskValue')}</span>
                      <input
                        className="mg-input"
                        type="text"
                        value={identity.task}
                        placeholder={t('taskPlaceholder')}
                        disabled={disabled}
                        onChange={(event) => { props.onChange(at, { ...identity, task: event.target.value }) }}
                      />
                    </label>
                  </div>
                  {teamIssue !== undefined
                    ? <p className="mg-issue" role="alert">{t(issueKey(teamIssue.code))}</p>
                    : null}
                  {identity.headers.map((entry, row) => {
                    const rowIssue = identityIssues.find(issue => issue.row === row)
                    const nameInvalid = rowIssue !== undefined && rowIssue.code !== 'value-invalid'
                    const valueInvalid = rowIssue?.code === 'value-invalid'
                    return (
                      <div className="mg-header-row" key={row}>
                        <input
                          className={`mg-input${nameInvalid ? ' mg-input-invalid' : ''}`}
                          type="text"
                          value={entry.name}
                          placeholder={t('headerName')}
                          aria-label={`${t('headerName')} ${String(at + 1)}-${String(row + 1)}`}
                          disabled={disabled}
                          onChange={(event) => { patchRow(at, row, { name: event.target.value }) }}
                        />
                        <input
                          className={`mg-input${valueInvalid ? ' mg-input-invalid' : ''}`}
                          type="text"
                          value={entry.value}
                          placeholder={t('headerValue')}
                          aria-label={`${t('headerValue')} ${String(at + 1)}-${String(row + 1)}`}
                          disabled={disabled}
                          onChange={(event) => { patchRow(at, row, { value: event.target.value }) }}
                        />
                        <button
                          type="button"
                          className="mg-button mg-button-icon mg-button-small"
                          aria-label={`${t('removeHeader')} ${String(at + 1)}-${String(row + 1)}`}
                          title={t('removeHeader')}
                          disabled={disabled}
                          onClick={() => {
                            props.onChange(at, { ...identity, headers: identity.headers.filter((_, atRow) => atRow !== row) })
                          }}
                        >
                          −
                        </button>
                        {rowIssue !== undefined
                          ? <p className="mg-issue" role="alert">{t(issueKey(rowIssue.code))}</p>
                          : null}
                      </div>
                    )
                  })}
                  <div>
                    <button
                      type="button"
                      className="mg-button mg-button-small"
                      aria-label={`${t('addHeader')} ${String(at + 1)}`}
                      disabled={disabled}
                      onClick={() => {
                        props.onChange(at, { ...identity, headers: [...identity.headers, { name: '', value: '' }] })
                      }}
                    >
                      + {t('addHeader')}
                    </button>
                  </div>
                </div>
              )
              : null}
          </section>
        )
      })}
      <div style={{ marginTop: '4px' }}>
        <button
          type="button"
          className="mg-button"
          disabled={disabled}
          onClick={props.onAdd}
        >
          + {t('addIdentity')}
        </button>
      </div>
    </>
  )
}