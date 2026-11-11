/**
 * The browser half's stylesheet. The card chrome and field controls are
 * 1:1 ports of the official `ui-settings-plugins` PluginCard / fields rules
 * and the `ui-settings-models` model-catalog input rules — same `--dsw-alias-*`
 * design tokens, same geometry — so the plugin's surfaces are visually
 * indistinguishable from the shipped ones. Class names use the `mg-` prefix
 * (CSS-module hashes are per-package and cannot be reused).
 *
 * @module dsh-memory-header-gate/client/styles
 */

export const STYLES = `
/* ---- Plugin-configuration card (ported from PluginCard.module.css) ---- */
.mg-card {
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.mg-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.mg-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.mg-card-header {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.mg-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mg-card-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.mg-card-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.mg-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; display: inline-flex; }
.mg-chevron-open { transform: rotate(180deg); }
.mg-card-body { border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.mg-readonly { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.mg-empty { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

/* The explanatory block under the card title (proxy / pinning / detach). */
.mg-notes { display: flex; flex-direction: column; gap: 4px; padding: 12px 0 4px; }
.mg-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

/* Section headers inside the card body ("记忆身份" / "默认与头名" / "会话与预算"). */
.mg-section-title {
  margin: 16px 0 8px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

/* Tag tone="neutral" port (the "unsaved" capsule on the card header). */
.mg-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  flex: none;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}

/* Card footer buttons (ported from PluginCard.module.css). */
.mg-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.mg-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.mg-button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.mg-button:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.mg-button-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); border-color: transparent; }
.mg-button:disabled { opacity: 0.4; cursor: default; }
.mg-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mg-button-small { padding: 2px 10px; font-size: 12px; }
.mg-button-icon { padding: 0 8px; font-weight: 600; }

/* ---- Identity blocks: one collapsible section per identity ---- */
.mg-identity { padding: 12px 0; display: flex; flex-direction: column; gap: 6px; }
.mg-identity + .mg-identity { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.mg-identity-head { display: flex; align-items: center; gap: 8px; }
.mg-identity-toggle {
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
}
.mg-identity-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mg-identity-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mg-identity-title-unset { color: var(--dsw-alias-label-dimmed); font-weight: 400; }
.mg-identity-body { display: flex; flex-direction: column; gap: 8px; padding-top: 2px; }
.mg-header-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
}
.mg-header-row .mg-issue { grid-column: 1 / -1; margin: -2px 0 0; }
.mg-issue { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }

/* Labelled field groups (identity triple, header names, default identity). */
.mg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mg-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mg-triple { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-items: start; }
.mg-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.mg-check input { accent-color: var(--dsw-alias-brand-primary); }

/* Field inputs (ported from fields.module.css / ModelsSection .input). */
.mg-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.mg-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.mg-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mg-input:disabled { opacity: 0.6; cursor: default; }
.mg-input-invalid { border-color: var(--dsw-alias-label-error); }
.mg-input-select { cursor: pointer; }
.mg-input-narrow { max-width: 220px; }

/* ---- Models-page picker: a .modelField row inside the Capacities disclosure ---- */
/* The mount wrapper (not the React picker) is the item the official disclosure
   grid places; the span puts it on the row below 上下文窗口 / 最大输出. */
.mg-field-row { grid-column: 1 / -1; }
.mg-select { display: flex; flex-direction: column; gap: 4px; }
.mg-field-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.mg-select-input {
  appearance: none;
  box-sizing: border-box;
  width: 100%;
  max-width: 240px;
  height: 32px;
  padding: 0 32px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  background-color: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  /* Data-URI SVGs cannot resolve CSS variables; #81858C is the caption gray
     shared by both themes (same port as the official .selectInput). */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
.mg-select-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mg-select-input:disabled { opacity: 0.6; cursor: default; }
.mg-select[data-failed="true"] .mg-select-input { border-color: var(--dsw-alias-label-error); }
.mg-select-status { max-width: 240px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.mg-select[data-failed="true"] .mg-select-status { color: var(--dsw-alias-label-error); }
`